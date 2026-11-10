/* Family sync for TatNet Supabase. Public key only, all financial access protected by server RLS. */
import {getAll,insertMany,remove,replaceDatabase,openDB} from './db.js';
const URL='https://2c806c4c9bd2bdbf2fbddcd6fcfb1fa3.supa.tatnet.cloud';
const KEY='sb_publishable_xVVpL3auVecoOVAEklekjloQwylh';
const AUTH='moy-koshelek-cloud-auth-v9', LINK='moy-koshelek-cloud-link-v9';
const kinds=['wallets','categories','transactions','budgets'];
let session=null, family=null, active=false, busy=false, suppressed=false, interval=null, debounce=null, lastError='', lastSyncAt=null;
const json=k=>{try{return JSON.parse(localStorage.getItem(k))}catch{return null}};
const watchers=new Set();
export const onStatus=f=>{watchers.add(f);return()=>watchers.delete(f)};
export const status=()=>({signedIn:!!session?.access_token,email:session?.user?.email||'',family,active,busy,lastError,lastSyncAt});
const update=()=>{for(const f of watchers)try{f(status())}catch{}};
function persist(){session?localStorage.setItem(AUTH,JSON.stringify(session)):localStorage.removeItem(AUTH);family?localStorage.setItem(LINK,JSON.stringify({family,active,userId:session?.user?.id||null})):localStorage.removeItem(LINK);update()}
async function refresh(){if(!session?.refresh_token||Date.now()<(session.expiresAt||0)-90000)return;const r=await fetch(URL+'/auth/v1/token?grant_type=refresh_token',{method:'POST',headers:{apikey:KEY,'Content-Type':'application/json'},body:JSON.stringify({refresh_token:session.refresh_token})});if(!r.ok)throw Error('Сессия истекла. Войди снова.');const s=await r.json();session={...s,expiresAt:Date.now()+(s.expires_in||3600)*1000};persist()}
async function api(path,{method='GET',data,auth=true}={}){
 if(auth){if(!session?.access_token)throw Error('Войди в аккаунт');await refresh()}
 const headers={apikey:KEY,'Content-Type':'application/json'};if(auth)headers.Authorization='Bearer '+session.access_token;
 let response;try{response=await fetch(URL+path,{method,headers,...(data===undefined?{}:{body:JSON.stringify(data)})})}catch{throw Error('Нет соединения; изменения остались на устройстве')}
 if(!response.ok){let m='';try{const x=await response.json();m=x.message||x.msg||x.error_description||x.error||''}catch{}throw Error(m||'Ошибка сервера: '+response.status)}
 const t=await response.text();return t?JSON.parse(t):null;
}
export async function signIn(email,password){
 const s=await api('/auth/v1/token?grant_type=password',{method:'POST',data:{email:email.trim(),password},auth:false});
 const oldLink=json(LINK);
 session={...s,expiresAt:Date.now()+(s.expires_in||3600)*1000};family=null;active=false;persist();
 const list=await families();
 if(list.length===1){
   family=list[0].family_id;
   active=!!(oldLink?.active&&oldLink.family===family&&oldLink.userId===session.user?.id);
   persist();if(active)start();
 }
 return list;
}
export async function signUp(email,password){const s=await api('/auth/v1/signup',{method:'POST',data:{email:email.trim(),password},auth:false});if(!s.access_token)return false;session={...s,expiresAt:Date.now()+(s.expires_in||3600)*1000};family=null;active=false;persist();return true}
export function signOut(){if(interval)clearInterval(interval);clearTimeout(debounce);session=null;family=null;active=false;persist()}
export async function families(){return api('/rest/v1/family_members?select=family_id,role&order=joined_at.asc')}
export async function chooseFamily(id){if(!(await families()).some(x=>x.family_id===id))throw Error('Нет доступа к семье');const prev=json(LINK);family=id;active=prev?.family===id&&prev.active===true&&prev.userId===session?.user?.id;persist();if(active)start();return active}
export async function createFamily(name){const x=await api('/rest/v1/rpc/create_family',{method:'POST',data:{family_name:name}});const item=Array.isArray(x)?x[0]:x;family=item.family_id;active=false;persist();return item.invite_code}
export async function joinFamily(code){family=await api('/rest/v1/rpc/join_family',{method:'POST',data:{invite_code:code.trim().toLowerCase()}});active=false;persist();return family}
export async function rotateInvite(){return api('/rest/v1/rpc/rotate_family_invite_code',{method:'POST',data:{fid:family}})}
async function putStore(name,key,value){const db=await openDB();return new Promise((ok,fail)=>{const t=db.transaction(name,'readwrite');const s=t.objectStore(name);value?s.put({key,...value}):s.delete(key);t.oncomplete=ok;t.onerror=()=>fail(t.error)})}
async function getStore(name,key){const db=await openDB();return new Promise((ok,fail)=>{const q=db.transaction(name,'readonly').objectStore(name).get(key);q.onsuccess=()=>ok(q.result);q.onerror=()=>fail(q.error)})}
const recordKey=(type,id)=>family+'|'+type+'|'+id;
const revision=async(type,id)=>(await getStore('cloud_meta',recordKey(type,id)))?.rev||0;
const setRevision=(type,id,rev)=>putStore('cloud_meta',recordKey(type,id),{rev});
const queued=async()=> (await getAll('cloud_pending')).filter(x=>x.family===family);
export async function change(type,id,payload,deleted=false){if(!active||suppressed||!family||!session||!kinds.includes(type))return;const key=recordKey(type,id);await putStore('cloud_pending',key,{family,type,id,payload:deleted?null:payload,deleted,nonce:crypto.randomUUID()});schedule()}
const schedule=()=>{clearTimeout(debounce);debounce=setTimeout(()=>sync().catch(e=>{lastError=e.message;update()}),1500)};
async function fetchAll(){const rows=[];let offset=0;while(true){const page=await api(`/rest/v1/sync_records?select=entity_type,record_id,payload,deleted,revision&family_id=eq.${family}&order=entity_type.asc,record_id.asc&limit=500&offset=${offset}`);rows.push(...page);if(page.length<500)break;offset+=500;if(offset>100000)throw Error('Слишком много записей')};return rows}
export async function cloudHasRecords(){return (await api(`/rest/v1/sync_records?select=record_id&family_id=eq.${family}&limit=1`)).length>0}
export async function counts(){return Object.fromEntries(await Promise.all(kinds.map(async x=>[x,(await getAll(x)).length])))}
async function push(batch){const result=await api('/rest/v1/rpc/apply_family_changes',{method:'POST',data:{fid:family,changes:batch.map(x=>({type:x.type,id:x.id,payload:x.deleted?null:x.payload,deleted:!!x.deleted,expected_rev:x.expected||0}))}});for(const x of result)await setRevision(x.type,x.id,Number(x.revision));return result}
export async function initialUpload(progress=()=>{}){
 if(active)throw Error('Уже подключено');if(!family)throw Error('Выбери семью');
 const remote=await fetchAll();
 const remoteIds=new Set(remote.map(x=>x.entity_type+'|'+x.record_id));
 const data=await Promise.all(kinds.map(getAll));
 const localIds=new Set(kinds.flatMap((type,i)=>data[i].map(x=>type+'|'+x.id)));
 if(remote.some(x=>!localIds.has(x.entity_type+'|'+x.record_id)))throw Error('В семейном бюджете есть другие записи. На этом устройстве сначала загрузи семейную историю.');
 const items=kinds.flatMap((type,i)=>data[i].filter(x=>!remoteIds.has(type+'|'+x.id)).map(x=>({type,id:String(x.id),payload:x,expected:0})));
 busy=true;update();try{for(let i=0;i<items.length;i+=60){await push(items.slice(i,i+60));progress(Math.min(i+60,items.length),items.length)}for(const x of remote)await setRevision(x.entity_type,x.record_id,Number(x.revision));active=true;lastSyncAt=new Date().toISOString();persist();start();return {sent:items.length,existing:remote.length}}finally{busy=false;update()}
}
export async function initialDownload(){if(!family)throw Error('Выбери семью');const remote=await fetchAll();if(!remote.length)throw Error('Семейная база пока пустая');const data=Object.fromEntries(kinds.map(x=>[x,[]]));for(const x of remote)if(!x.deleted&&kinds.includes(x.entity_type)&&x.payload)data[x.entity_type].push(x.payload);busy=true;suppressed=true;update();try{await replaceDatabase(data);for(const x of remote)await setRevision(x.entity_type,x.record_id,Number(x.revision));active=true;lastSyncAt=new Date().toISOString();persist();start();return Object.fromEntries(kinds.map(x=>[x,data[x].length]))}finally{suppressed=false;busy=false;update()}}
export async function sync(){
 if(!active||!session||!family||busy||!navigator.onLine)return;
 busy=true;lastError='';update();try{
  const remote=await fetchAll();const edits=await queued();const dirty=new Set(edits.map(x=>x.type+'|'+x.id));
  const added=Object.fromEntries(kinds.map(x=>[x,[]]));suppressed=true;
  try{for(const x of remote){if(!kinds.includes(x.entity_type)||dirty.has(x.entity_type+'|'+x.record_id))continue;const old=await revision(x.entity_type,x.record_id);if(Number(x.revision)<=old)continue;if(x.deleted)await remove(x.entity_type,x.record_id);else added[x.entity_type].push(x.payload);await setRevision(x.entity_type,x.record_id,Number(x.revision))}for(const name of kinds)if(added[name].length)await insertMany(name,added[name])}finally{suppressed=false}
  for(let i=0;i<edits.length;i+=60){const batch=edits.slice(i,i+60);for(const x of batch)x.expected=await revision(x.type,x.id);await push(batch);for(const x of batch){const current=await getStore('cloud_pending',recordKey(x.type,x.id));if(current?.nonce===x.nonce)await putStore('cloud_pending',recordKey(x.type,x.id),null)}}
  lastSyncAt=new Date().toISOString();window.dispatchEvent(new Event('cloud-changed'));return {sent:edits.length};
 }catch(e){lastError=e.message;throw e}finally{busy=false;update()}
}
function start(){if(interval)clearInterval(interval);interval=setInterval(()=>{if(!document.hidden)sync().catch(console.warn)},30000);schedule()}
export function init(){session=json(AUTH);const x=json(LINK);family=x?.family||null;active=!!x?.active&&!!session?.access_token&&x.userId===session?.user?.id;window.addEventListener('wallet-local-change',e=>{const d=e.detail;change(d.type,d.id,d.payload,d.deleted).catch(console.warn)});window.addEventListener('online',schedule);document.addEventListener('visibilitychange',()=>{if(!document.hidden&&active)schedule()});if(active&&session)start();update()}
