import { getAll, save, remove, insertMany, replaceDatabase, uid } from './db.js';
import { readCSVFile, guessMapping, parseAmount, parseDate, parseType, csvEscape, fingerprint } from './import.js';
import { recognizeImage, parseScreenshot } from './ocr.js';
import { detectJSONKind, validateBackup } from './data-import.js';
import * as cloud from './cloud.js';

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, x => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[x]));
const today = () => { const d = new Date(); return [d.getFullYear(), String(d.getMonth()+1).padStart(2,'0'), String(d.getDate()).padStart(2,'0')].join('-'); };
const shortDate = s => s ? new Date(s+'T12:00:00').toLocaleDateString('ru-RU',{day:'numeric',month:'short',year:'numeric'}) : '—';
const format = (minor, cur='RUB') => { const v = (minor || 0) / 100; try { return new Intl.NumberFormat('ru-RU',{style:'currency',currency:cur,maximumFractionDigits:2}).format(v); } catch { return v.toFixed(2)+' '+cur; } };
const money = (v,cur) => `<span class="${v >= 0 ? 'positive' : 'negative'}">${esc(format(v,cur))}</span>`;
const datePeriod = () => {
  if (state.period === 'all') return '';
  if (state.period === 'year') return today().slice(0,4)+'-01-01';
  return state.focusMonth+'-01';
};
const cleanName = s => String(s??'').trim().replace(/\s+/g,' ');
const labelIcons={income:'↑',expense:'↓',transfer:'⇄'};
const svgIcon=(name,extra='')=>`<svg class="ico ${extra}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const monthTitle=(ym,full=false)=>new Date(ym+'-01T12:00:00').toLocaleDateString('ru-RU',{month:full?'long':'short',year:'numeric'}).replace(/\s*г\.$/,'');
const dayTitle=date=>new Date(date+'T12:00:00').toLocaleDateString('ru-RU',{day:'numeric',month:'long'});
const moveMonth=(ym,by)=>{const d=new Date(ym+'-01T12:00:00');d.setMonth(d.getMonth()+by);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;};
const compactAmount=(minor)=>{const abs=Math.abs(minor)/100;return abs>=1000000?(abs/1000000).toFixed(1).replace('.0','')+'м':abs>=1000?(abs/1000).toFixed(1).replace('.0','')+'к':Math.round(abs).toString();};
const FAMILY_KEY='moy-koshelek-profile-v8';
const profilePref=()=>{try{return localStorage.getItem(FAMILY_KEY)||'me';}catch{return 'me';}};
const DEVICE_KEY='moy-koshelek-device-owner-v8';
const devicePref=()=>{try{return localStorage.getItem(DEVICE_KEY)||'me';}catch{return 'me';}};
const saveLocal=(key,value)=>{try{localStorage.setItem(key,value);}catch{}};
const OWNERS={me:'Мой',wife:'Жены',matvey:'Матвей',family:'Семья'};
const PROFILE_IMAGES={me:'./assets/logo-man.webp',wife:'./assets/logo-light.webp',matvey:'./assets/logo-matvey.webp',family:'./assets/logo-family.webp'};
const PROFILE_LOOK={me:{name:'Мой кошелёк',sub:'Личный бюджет',emoji:'🌙',theme:'night'},wife:{name:'Кошелёк жены',sub:'Личный бюджет',emoji:'🌸',theme:'rose'},matvey:{name:'Кошелёк Матвея',sub:'Накопления и расходы',emoji:'🧸',theme:'aqua'},family:{name:'Семейный бюджет',sub:'Общий кошелёк',emoji:'💚',theme:'mint'}};
let state = { wallets:[], categories:[], transactions:[], budgets:[], catUI:{type:'expense',view:'active',sort:'frequent',search:''}, houseUI:{section:'all',subproject:'all',search:''}, page:'dashboard', walletId:null, profileId:profilePref(), deviceOwner:devicePref(), period:'month', focusMonth:today().slice(0,7), txFilters:{search:'',category:'all',kind:'all',from:'',to:'',min:'',max:''}, maxTx:100, importRows:null, importHeaders:null, importMapping:null };

function wallet() {
 const picked=state.wallets.find(w=>w.id===state.walletId&&w.status!=='closed');
 if(picked&&(state.profileId==='family'||ownerOfWallet(picked)===state.profileId))return picked;
 return state.wallets.find(w=>w.status!=='closed'&&state.profileId!=='family'&&ownerOfWallet(w)===state.profileId&&w.currency==='RUB')||state.wallets.find(w=>w.status!=='closed'&&w.currency==='RUB')||state.wallets.find(w=>w.status!=='closed')||state.wallets[0];
}
function ownerOfWallet(w){return ['me','wife','matvey','family'].includes(w?.ownerId)?w.ownerId:'me';}
function ownerOfTx(t){return ['me','wife','matvey','family'].includes(t?.ownerId)?t.ownerId:ownerOfWallet(state.wallets.find(w=>w.id===t.walletId));}
function scopeMatches(t){return state.profileId==='family'||ownerOfTx(t)===state.profileId;}
function walletCurrencyMatches(t,w){return (state.wallets.find(x=>x.id===t.walletId)?.currency||'RUB')===w.currency;}
function visibleTx(t,w){return scopeMatches(t)&&walletCurrencyMatches(t,w);}
function displayDelta(t,w){
 if(t.type==='income')return t.amountMinor;
 if(t.type==='expense')return -netExpense(t);
 return 0; // Переводы не являются семейным доходом или расходом.
}
function ownerOptions(selected='me',family=false){return ['me','wife','matvey',...(family?['family']:[])].map(id=>opt(id,OWNERS[id],selected===id)).join('');}
function profileBar(){return `<div class="profile-bar premium-switch" role="group" aria-label="Выбрать бюджет">${['me','wife','matvey','family'].map(id=>`<button class="profile-option ${state.profileId===id?'current':''}" data-action="select-profile" data-id="${id}" aria-pressed="${state.profileId===id}"><img class="profile-avatar" src="${PROFILE_IMAGES[id]}" alt=""><span>${OWNERS[id]}</span></button>`).join('')}</div>`;}
function applyTheme(){
 const theme=PROFILE_LOOK[state.profileId]?.theme||'night';
 document.documentElement.dataset.theme=theme;
 document.querySelector('meta[name="theme-color"]')?.setAttribute('content',({night:'#171717',rose:'#fff0f5',mint:'#e8f8e7',aqua:'#e4f9fa'})[theme]);
 const profile=PROFILE_LOOK[state.profileId]||PROFILE_LOOK.me;
 const title=document.querySelector('#brand-profile-title');if(title)title.textContent=state.page==='house'?'Наш дом':profile.name;
 const subtitle=document.querySelector('#brand-profile-sub');if(subtitle)subtitle.textContent=state.page==='house'?'Наш семейный проект':profile.sub;
 const img=document.querySelector('#brand-mascot');if(img)img.src=PROFILE_IMAGES[state.profileId];
 const aside=document.querySelector('.aside-brand');if(aside)aside.src=PROFILE_IMAGES[state.profileId];
}
function cat(id) { return state.categories.find(c=>c.id===id); }
function walletName(id) { return state.wallets.find(w=>w.id===id)?.name || 'Кошелёк'; }
function isWalletTx(t,w) { return visibleTx(t,w); }
function benefit(t) { return t.type==='expense' ? Math.min(t.amountMinor, Math.max(0,Number.isSafeInteger(t.cashbackMinor)?t.cashbackMinor:0)) : 0; }
function netExpense(t) { return Math.max(0,t.amountMinor-benefit(t)); }
function cashbackTotals(rows,w) { const expenses=rows.filter(t=>t.type==='expense'&&visibleTx(t,w)); return {gross:expenses.reduce((s,t)=>s+t.amountMinor,0), cashback:expenses.reduce((s,t)=>s+benefit(t),0),count:expenses.filter(t=>benefit(t)>0).length}; }
function settledCashback(t,dateEnd) {return t.type==='expense'&&t.cashbackStatus==='received'&&(t.cashbackDate||t.date)<=dateEnd?benefit(t):0;}
function txDelta(t,w) {
  if (t.type==='income' && t.walletId===w.id) return t.amountMinor;
  if (t.type==='expense' && t.walletId===w.id) return -netExpense(t);
  if (t.type==='transfer') return (t.toWalletId===w.id ? (t.toAmountMinor ?? t.amountMinor) : 0) - (t.walletId===w.id ? t.amountMinor : 0);
  return 0;
}
function balance(w,dateEnd=today()) {
 if(w?.balanceAnchorAt && w?.balanceAnchorDate && dateEnd>=w.balanceAnchorDate && Number.isSafeInteger(w.balanceAnchorMinor)){
  return w.balanceAnchorMinor+state.transactions.reduce((sum,t)=>{
   if(t.walletId!==w.id && t.toWalletId!==w.id)return sum;
   // Control point is at the moment the actual bank balance was entered.
   // Pre-imported records, including transactions from the same date, cannot count again.
   if(t.date<w.balanceAnchorDate)return sum;
   if(t.date===w.balanceAnchorDate && (!t.createdAt || t.createdAt<=w.balanceAnchorAt))return sum;
   if(t.date>dateEnd)return sum;
   if(t.type==='expense'&&t.walletId===w.id)return sum-t.amountMinor+(t.cashbackStatus==='received'?benefit(t):0);
   return sum+txDelta(t,w);
  },0);
 }
 return (w.initialBalanceMinor||0)+state.transactions.reduce((sum,t)=>{
   if(t.type==='expense'&&t.walletId===w.id) return sum-(t.date<=dateEnd?t.amountMinor:0)+settledCashback(t,dateEnd);
   return sum+(t.date<=dateEnd?txDelta(t,w):0);
 },0);
}
function filteredByPeriod(w) { const start=datePeriod(); const end=state.period==='month'?state.focusMonth+'-31':today();return state.transactions.filter(t=>isWalletTx(t,w)&&(!start||t.date>=start)&&t.date<=end); }
function sumType(rows,type,w) { return rows.filter(t=>t.type===type && visibleTx(t,w)).reduce((s,t)=>s+(type==='expense'?netExpense(t):t.amountMinor),0); }
function sortTx(a,b){ return b.date.localeCompare(a.date) || String(b.createdAt||'').localeCompare(String(a.createdAt||'')); }
const opt=(value,label,selected)=>`<option value="${esc(value)}" ${selected?'selected':''}>${esc(label)}</option>`;
function isCategoryHidden(c, profileId=state.profileId){return Array.isArray(c.hiddenProfiles)&&c.hiddenProfiles.includes(profileId);}
function categoryOptions(type, selected='', allowAll=false, onlyActive=false){
  const cats=state.categories.filter(c=>(type==='all'||c.type===type)&&(!onlyActive||!isCategoryHidden(c)||c.id===selected)).sort((a,b)=>a.name.localeCompare(b.name,'ru'));
  return (allowAll?opt('all','Все категории',selected==='all'):'')+cats.map(c=>opt(c.id,c.name,c.id===selected)).join('');
}
function walletOptions(selected='', filter=()=>true){return state.wallets.filter(w=>(w.status!=='closed'||w.id===selected)&&filter(w)).map(w=>opt(w.id,`${w.name}${w.status==='closed'?' (архив)':''} · ${w.currency}`,w.id===selected)).join('');}
async function loadData(){
  const [wallets,categories,transactions,budgets]=await Promise.all(['wallets','categories','transactions','budgets'].map(getAll));
  Object.assign(state,{wallets,categories,transactions,budgets});
  if(!wallets.length){
    const w={id:uid(),name:'Наличные',currency:'RUB',initialBalanceMinor:0};
    await save('wallets',w); state.wallets=[w];
  }
  // V15: do not recreate family wallets after the user deletes or archives them.
  if(!categories.length){
    const seed=[{id:uid(),name:'Другое',type:'income',color:'#50b9a1'},{id:uid(),name:'Другое',type:'expense',color:'#e66b80'}];
    await insertMany('categories',seed);state.categories=seed;
  }
  if (!state.wallets.some(w=>w.id===state.walletId&&w.status!=='closed')) state.walletId=state.wallets.find(w=>w.status!=='closed')?.id||state.wallets[0].id;
  // Legacy Spendee backup has no owner fields: all historic rows remain assigned to "Мой".
  if(!['me','wife','matvey','family'].includes(state.profileId))state.profileId='me';
  if(!['me','wife'].includes(state.deviceOwner))state.deviceOwner='me';
}
function toast(message){const t=$('#toast');t.textContent=message;t.classList.add('visible');clearTimeout(toast.timer);toast.timer=setTimeout(()=>t.classList.remove('visible'),3500);}
function render(){
  const titles={dashboard:'Главная',accounts:'Счета',overview:'Обзор',house:'Наш дом',transactions:'История',budgets:'Бюджеты',settings:'Больше',categories:'Категории'};
  $('#page-title').textContent=titles[state.page]||'Мой кошелёк';
  const fab=$('#floating-add');if(fab)fab.classList.toggle('hidden',state.page==='categories');
  applyTheme();
  $('#profile-switch').innerHTML=profileBar();
  $('#wallet-picker').innerHTML=walletOptions(wallet()?.id);
  $('#global-search').value=state.txFilters.search;
  document.querySelectorAll('[data-page]').forEach(b=>b.classList.toggle('active',b.dataset.page===state.page||(state.page==='transactions'&&b.dataset.page==='dashboard')));
  const pages={dashboard:renderDashboard,accounts:renderAccounts,overview:renderOverview,house:renderHomeProject,transactions:renderTransactions,budgets:renderBudgets,settings:renderSettings,categories:renderCategories};
  $('#content').innerHTML=pages[state.page]();
}
function monthlyTotals(w,month){
  const rows=state.transactions.filter(t=>t.date.startsWith(month)&&visibleTx(t,w));
  return {income:sumType(rows,'income',w),expense:sumType(rows,'expense',w)};
}
function cashFlowChart(w){
  // Keep the current month visible until the selection leaves the last six months.
  const current=today().slice(0,7),anchor=state.focusMonth>=moveMonth(current,-5)?current:state.focusMonth;
  const months=Array.from({length:6},(_,i)=>moveMonth(anchor,i-5));
  const data=months.map(m=>({...monthlyTotals(w,m),month:m}));
  const top=Math.max(1,...data.map(d=>Math.max(d.income,d.expense)));
  const height=132,bottom=165,step=81,start=36;
  const grid=[0,.5,1].map(f=>`<line x1="30" x2="507" y1="${bottom-f*height}" y2="${bottom-f*height}" stroke="#e6eaea" stroke-width="1"/><text x="0" y="${bottom-f*height+4}" font-size="11" fill="#a4b3b9">${compactAmount(top*f)}</text>`).join('');
  const rects=data.map((d,i)=>{
    const x=start+i*step;
    const ih=d.income>0?Math.max(4,d.income/top*height):0;
    const eh=d.expense>0?Math.max(3,d.expense/top*height):0;
    const selected=d.month===state.focusMonth;
    const label=new Date(d.month+'-01T12:00:00').toLocaleDateString('ru-RU',{month:'short'}).replace('.','');
    return `<g data-action="select-month" data-month="${d.month}" role="button" tabindex="0" aria-label="${esc(monthTitle(d.month))}: доход ${esc(format(d.income,w.currency))}, расход ${esc(format(d.expense,w.currency))}">
      <rect x="${x-14}" y="25" width="78" height="181" fill="transparent"/>
      <rect x="${x}" y="${bottom-ih}" width="30" height="${ih}" rx="5" fill="${selected?'#44bb88':'#6dcc9f'}"/>
      ${eh?`<rect x="${x+33}" y="${bottom-eh}" width="10" height="${eh}" rx="3" fill="#ed8b89"/>`:''}
      <text x="${x+17}" y="190" font-size="12" font-weight="${selected?800:500}" text-anchor="middle" fill="${selected?'#344955':'#96a7ae'}">${esc(label)}</text>
      <text x="${x+17}" y="206" font-size="11" font-weight="${selected?700:400}" text-anchor="middle" fill="${selected?'#344955':'#a1b0b4'}">${d.month.slice(0,4)}</text>
    </g>`;
  }).join('');
  return `<svg class="flow-chart" viewBox="0 0 520 214" role="img" aria-label="Доходы и расходы за шесть месяцев">${grid}${rects}</svg>`;
}
function groupedOperations(items,w,maxItems=100){
  const sorted=[...items].sort(sortTx).slice(0,maxItems);
  if(!sorted.length) return '<div class="empty"><strong>Операций пока нет</strong>Добавьте доход или импортируйте историю Spendee в разделе «Больше».</div>';
  const byDay=new Map();for(const t of sorted){if(!byDay.has(t.date))byDay.set(t.date,[]);byDay.get(t.date).push(t);}
  return [...byDay].map(([date,dayRows])=>{
    const net=dayRows.reduce((sum,t)=>sum+displayDelta(t,w),0);
    const dayContent=dayRows.map(t=>{
      const amount=displayDelta(t,w),name=t.type==='transfer'?`Перевод · ${walletName(t.toWalletId||t.walletId)}`:cat(t.categoryId)?.name||'Без категории';
      const detail=String(t.note||'').trim();
      const cash=benefit(t), cashbackNote=cash>0?`<span class="operation-cashback">🎁 Выгода от кешбэка: +${esc(format(cash,w.currency))}</span>`:'';
      const symbol=t.type==='income'?'up':t.type==='expense'?'down':'transfer';
      const paidBy=state.wallets.find(x=>x.id===t.walletId);
      const payerNote=t.type==='expense'&&ownerOfWallet(paidBy)!==ownerOfTx(t)?`<span class="operation-payer">Оплачено со счёта «${esc(paidBy?.name||'') }» (${esc(OWNERS[ownerOfWallet(paidBy)])})</span>`:'';
      return `<button class="activity-operation" data-action="edit-tx" data-id="${esc(t.id)}" aria-label="Изменить: ${esc(name)}, ${esc(format(amount,w.currency))}">
        <span class="operation-icon ${esc(t.type)}">${svgIcon(symbol)}</span>
        <span class="operation-text"><span class="operation-name">${esc(name)}</span>${detail?`<span class="operation-note">${esc(detail)}</span>`:''}${payerNote}${cashbackNote}</span>
        <span class="operation-money ${amount>=0?'positive':'negative'}">${esc(t.type==='transfer'?'⇄ '+format(t.amountMinor,w.currency):format(amount,w.currency))}</span>
      </button>`;
    }).join('');
    return `<section class="activity-day"><div class="day-header"><span>${esc(dayTitle(date))}</span><span>${esc(format(net,w.currency))}</span></div><div class="day-operations">${dayContent}</div></section>`;
  }).join('');
}
function profileWallets(){return state.wallets.filter(w=>(state.profileId==='family'||ownerOfWallet(w)===state.profileId)&&w.currency==='RUB'&&w.status!=='closed');}
function portfolio(){return profileWallets().reduce((sum,w)=>sum+balance(w),0);}
function knownBalance(){return profileWallets().length>0&&profileWallets().every(w=>Boolean(w.balanceAnchorAt));}
function themedBarChart(type='expense'){
 const w=wallet(),current=today().slice(0,7),anchor=state.focusMonth>=moveMonth(current,-5)?current:state.focusMonth;
 const months=Array.from({length:6},(_,i)=>moveMonth(anchor,i-5));
 const data=months.map(month=>({month,...monthlyTotals(w,month)}));
 const top=Math.max(1,...data.map(x=>x[type]));
 return `<div class="lux-chart ${type==='income'?'lux-income-chart':'lux-expense-chart'}" role="group" aria-label="${type==='income'?'Доходы':'Расходы'} по месяцам, выбрать месяц">${data.map(d=>{
 const height=d[type]===0?0:Math.max(7,Math.round(d[type]/top*100));const current=d.month===state.focusMonth;
 return `<button class="lux-chart-month ${current?'chosen':''}" data-action="select-month" data-month="${d.month}" title="${esc(monthTitle(d.month))}: ${esc(format(d[type],w.currency))}"><span class="lux-chart-value">${current?esc(format(d[type],w.currency)):''}</span><span class="lux-bar-shell"><span class="lux-bar" style="height:${height}%"></span></span><span class="lux-chart-label">${esc(new Date(d.month+'-01T12:00:00').toLocaleDateString('ru-RU',{month:'short'}).replace('.',''))}</span></button>`;}).join('')}</div>`;
}
function premiumTransactionRows(rows,limit=5){
 const w=wallet(),r=[...rows].filter(t=>walletCurrencyMatches(t,w)&&t.type!=='transfer').sort(sortTx).slice(0,limit);
 if(!r.length)return `<div class="premium-empty">Операций пока нет <button class="text-action" data-action="add-tx">Добавить первую</button></div>`;
 return r.map(t=>{const c=cat(t.categoryId),delta=displayDelta(t,w);
 return `<button class="lux-tx-row" data-action="edit-tx" data-id="${esc(t.id)}"><span class="lux-tx-icon">${c?iconForCategory(c):t.type==='income'?'💰':'🧾'}</span><span class="lux-tx-info"><b>${esc(c?.name||'Без категории')}</b><small>${esc(shortDate(t.date))}${t.projectId==='home'?' · 🏡 Дом':''}${t.houseSubprojectId?' · '+esc(houseTaxonomy().subprojects.find(x=>x.id===t.houseSubprojectId)?.name||'Подпроект'):''}${benefit(t)>0?' · 🎁 +'+esc(format(benefit(t))):''}</small></span><strong class="${delta>=0?'positive':'negative'}">${delta>0?'+':''}${esc(format(delta,w.currency))}</strong></button>`;
 }).join('');
}
function accountVisual(w){return w.kind==='deposit'?'🏦':w.kind==='savings'?'🌱':w.kind==='cash'?'💵':ownerOfWallet(w)==='wife'?'💗':ownerOfWallet(w)==='matvey'?'🧸':'💳';}
function premiumAccountCards(limit=6){return profileWallets().slice(0,limit).map(w=>`<button class="lux-account-tile" data-action="edit-wallet" data-id="${esc(w.id)}"><span class="lux-account-symbol">${accountVisual(w)}</span><span class="lux-account-name">${esc(w.name)}</span><strong>${esc(format(balance(w),w.currency))}</strong>${w.kind==='deposit'?`<small>${Number(w.rate||0)}% годовых</small>`:''}</button>`).join('');}
function renderDashboard(){
 const w=wallet(),p=PROFILE_LOOK[state.profileId],month=state.focusMonth,{income,expense}=monthlyTotals(w,month);
 const spentToday=sumType(state.transactions.filter(t=>t.date===today()),'expense',w);
 const cash=cashbackTotals(state.transactions.filter(t=>t.date.startsWith(month)),w).cashback;
 const transactions=state.transactions.filter(t=>scopeMatches(t)&&t.date<=today());
 const isFamily=state.profileId==='family',isKid=state.profileId==='matvey';
 const houseRows=state.transactions.filter(t=>t.projectId==='home'&&t.type==='expense');
 const plannedRecurring=state.budgets.filter(b=>b.kind==='recurring'&&b.ownerId==='matvey');
 return `<div class="lux-dashboard">
 <section class="lux-hero lux-panel"><div class="lux-eyebrow">${isFamily?'ВСЯ СЕМЬЯ':isKid?'КОШЕЛЁК МАТВЕЯ':'ЛИЧНЫЕ ФИНАНСЫ'} <span>✦</span></div><div class="lux-hero-title">${knownBalance()?'Актуальный баланс':'Расчётный баланс'}</div>
 <div class="lux-balance">${esc(format(portfolio(),w.currency))}</div>
 <div class="lux-hero-symbol" aria-hidden="true">${isKid?'🧸':isFamily?'💚':state.profileId==='wife'?'♡':'✦'}</div>
 <div class="lux-stats"><button class="lux-metric metric-in" data-action="show-transactions"><small>↘ Доходы</small><b>+${esc(format(income,w.currency))}</b></button><button class="lux-metric metric-out" data-action="show-transactions"><small>↗ Расходы</small><b>−${esc(format(expense,w.currency))}</b></button><button class="lux-metric metric-cash"><small>🎁 Кешбэк</small><b>+${esc(format(cash,w.currency))}</b></button></div>
 ${!knownBalance()?`<button class="lux-balance-hint" data-action="adjust-balances">Сверить с реальными счетами <span>›</span></button>`:''}</section>
 <section class="lux-panel lux-section"><div class="lux-section-head"><h2>${isKid?'Расходы Матвея':'Расходы по месяцам'}</h2><span class="lux-pill">${esc(monthTitle(month,true))}</span></div>${themedBarChart('expense')}<div class="lux-chart-footer"><button data-action="prev-month">‹ Раньше</button><button data-action="current-month">Текущий месяц</button><button data-action="next-month" ${month>=today().slice(0,7)?'disabled':''}>Позже ›</button></div></section>
 <section class="lux-panel lux-section lux-income-section"><div class="lux-section-head"><h2>${isKid?'Поступления Матвея':'Доходы по месяцам'}</h2><span class="lux-pill lux-income-total">+${esc(format(income,w.currency))} за месяц</span></div>${themedBarChart('income')}<p class="lux-chart-note">${isKid?'Поступления, подарки и пополнение копилки':'Доходы по всем категориям за выбранные месяцы'}</p></section>
 ${isKid?`<section class="lux-panel lux-section"><div class="lux-section-head"><h2>Регулярные расходы</h2><button class="text-action" data-action="add-recurring">+ Добавить</button></div>${plannedRecurring.length?plannedRecurring.slice(0,4).map(b=>`<button class="lux-mini-row" data-action="pay-recurring" data-id="${esc(b.id)}"><span>🧸 ${esc(b.name)}</span><strong>${esc(format(b.limitMinor))} / мес.</strong></button>`).join(''):'<p class="muted small-text">Садик, кружки, занятия — можно настроить ежемесячные платежи.</p>'}</section>`:''}
 <section class="lux-panel lux-section"><div class="lux-section-head"><h2>Последние операции</h2><button class="text-action" data-action="show-transactions">Все ›</button></div>${premiumTransactionRows(transactions,isKid?4:5)}<div class="lux-quick-actions"><button data-action="add-tx">＋ Записать операцию</button><button data-action="scan-expense">📷 Со скриншота</button></div></section>
 ${isFamily?`<section class="lux-panel lux-section"><div class="lux-section-head"><h2>Кошельки семьи</h2><button class="text-action" data-page="accounts">Счета ›</button></div><div class="lux-family-tiles">${['me','wife','matvey','family'].map(id=>`<button data-action="select-profile" data-id="${id}"><span>${PROFILE_LOOK[id].emoji}</span><b>${OWNERS[id]}</b><strong>${esc(format(state.wallets.filter(w=>ownerOfWallet(w)===id&&w.currency==='RUB'&&w.status!=='closed').reduce((sum,w)=>sum+balance(w),0)))}</strong></button>`).join('')}</div></section>`:
 `<section class="lux-panel lux-section"><div class="lux-section-head"><h2>${isKid?'Копилка и накопления':'Счета и накопления'}</h2><button class="text-action" data-page="accounts">Управлять ›</button></div><div class="lux-account-grid">${premiumAccountCards(3)}</div></section>`}
 <section class="lux-panel lux-section lux-income-breakdown"><div class="lux-section-head"><h2>Доходы по категориям</h2><button class="text-action" data-page="overview">Подробно ›</button></div>${categoriesBar(state.transactions.filter(t=>t.date.startsWith(month)), 'income', w)}</section>
 ${houseRows.length||isFamily?`<button class="lux-house-preview lux-panel" data-page="house"><img src="./assets/our-house.webp" alt="Эскиз нашего дома" loading="lazy"><span><b>Наш дом</b><small>${houseRows.length} операций по проекту · ${esc(format(houseRows.reduce((sum,t)=>sum+netExpense(t),0)))}</small></span><span>›</span></button>`:''}
 </div>`;
}
function renderAccounts(){
 const accounts=profileWallets(),archived=state.wallets.filter(x=>x.status==='closed'&&x.currency==='RUB'&&(state.profileId==='family'||ownerOfWallet(x)===state.profileId)),w=wallet();
 return `<div class="lux-dashboard"><section class="lux-hero lux-panel accounts-hero"><div class="lux-eyebrow">СЧЕТА И НАКОПЛЕНИЯ ✦</div><div class="lux-hero-title">${knownBalance()?'Текущий баланс':'Расчётный баланс'}</div><div class="lux-balance">${esc(format(portfolio(),w.currency))}</div><div class="lux-hero-symbol">✧</div><p class="lux-account-advice">${knownBalance()?'Остатки сверены с реальными счетами':'После импорта истории лучше указать реальные остатки'}</p></section>
 <section class="lux-panel lux-section"><div class="lux-section-head"><h2>Мои счета</h2><button class="text-action" data-action="add-wallet">＋ Новый</button></div><div class="lux-account-list">${accounts.map(a=>`<div class="lux-account-line"><span class="lux-account-symbol">${accountVisual(a)}</span><span><b>${esc(a.name)}</b><small>${esc(OWNERS[ownerOfWallet(a)])}${a.kind==='deposit'?' · вклад '+Number(a.rate||0)+'%':''}${a.balanceAnchorAt?' · ✓ сверено':''}</small></span><strong>${esc(format(balance(a),a.currency))}</strong><button data-action="edit-wallet" data-id="${esc(a.id)}" aria-label="Изменить счёт">›</button></div>`).join('')}</div>${archived.length?`<details class="lux-archived-accounts"><summary>Архивные счета (${archived.length})</summary><p class="small-text muted">Операции остаются в истории. Архивные счета не входят в текущий баланс.</p>${archived.map(a=>`<div class="lux-account-line lux-archived-line"><span class="lux-account-symbol">${accountVisual(a)}</span><span><b>${esc(a.name)}</b><small>Архив · ${esc(OWNERS[ownerOfWallet(a)])}</small></span><button data-action="edit-wallet" data-id="${esc(a.id)}" aria-label="Управлять архивным счётом">Вернуть ›</button></div>`).join('')}</details>`:''}<button class="lux-main-button" data-action="adjust-balances">✓ Актуализировать остатки</button></section>
 <section class="lux-panel lux-section"><div class="lux-section-head"><h2>Вклады и накопления</h2><button class="text-action" data-action="add-deposit">+ Добавить</button></div>${accounts.filter(a=>a.kind==='deposit'||a.kind==='savings').length?`<div class="lux-account-grid">${accounts.filter(a=>a.kind==='deposit'||a.kind==='savings').map(a=>`<button class="lux-account-tile" data-action="edit-wallet" data-id="${esc(a.id)}"><span class="lux-account-symbol">${accountVisual(a)}</span><span class="lux-account-name">${esc(a.name)}</span><strong>${esc(format(balance(a),a.currency))}</strong>${a.rate?`<small>${Number(a.rate)}% годовых</small>`:''}</button>`).join('')}</div>`:'<div class="premium-empty">Добавьте вклад или накопительный счёт</div>'}<div class="lux-quick-actions"><button data-action="add-interest">＋ Проценты по вкладу</button><button data-action="download-deposit-template">⇩ Шаблон CSV</button></div><details class="lux-extra-tools"><summary>Импорт вкладов и параметры</summary><label class="field">Загрузить список вкладов (CSV)<input type="file" id="deposit-csv-file" accept=".csv,text/csv"></label><p class="muted small-text">Вклад — это актив, а не доход. Процентные начисления учитываются отдельно.</p></details></section></div>`;
}
// House sections and subprojects are financial tags, never separate wallets or charges.
// Store the whole editable taxonomy as one 'budgets' record, so it is included
// in existing JSON backups and the current family sync without a DB migration.
const HOUSE_TAXONOMY_ID='house-taxonomy-v1';
const HOUSE_DEFAULT_SECTIONS=[
 {id:'materials',name:'Материалы',icon:'🧱',active:true},
 {id:'work',name:'Работы',icon:'🛠️',active:true},
 {id:'mortgage',name:'Ипотека',icon:'🏦',active:true},
 {id:'utilities',name:'Содержание',icon:'⚡',active:true},
 {id:'other',name:'Прочее',icon:'📦',active:true}
];
function houseTaxonomy(){
 const saved=state.budgets.find(b=>b.id===HOUSE_TAXONOMY_ID);
 return {sections:Array.isArray(saved?.sections)?saved.sections.map(x=>({...x})):HOUSE_DEFAULT_SECTIONS.map(x=>({...x})),
         subprojects:Array.isArray(saved?.subprojects)?saved.subprojects.map(x=>({...x})):[]};
}
function houseSectionForTx(t){
 if(t.houseSection)return t.houseSection;
 const n=(cat(t.categoryId)?.name||'')+' '+(t.note||'');
 return /ипотек/i.test(n)?'mortgage':/материал|бетон|кирпич|окн/i.test(n)?'materials':/работ|монтаж|строител/i.test(n)?'work':'other';
}
function houseSectionsOptions(selected=''){
 const sections=houseTaxonomy().sections.filter(x=>x.active!==false||x.id===selected);
 return sections.map(s=>opt(s.id,`${s.icon||'🏡'} ${s.name}${s.active===false?' (скрыт)':''}`,s.id===selected)).join('');
}
function houseSubprojectChoices(query='',form=document.querySelector('#tx-form')){
 if(!form)return;
 const taxonomy=houseTaxonomy(),section=form.elements.houseSection?.value;
 const selected=form.elements.houseSubproject?.value||'',q=query.trim().toLocaleLowerCase('ru');
 const options=taxonomy.subprojects.filter(x=>(x.active!==false||x.id===selected)&&(!q||x.name.toLocaleLowerCase('ru').includes(q)||taxonomy.sections.find(s=>s.id===x.sectionId)?.name.toLocaleLowerCase('ru').includes(q)))
 .sort((a,b)=>(b.id===selected)-(a.id===selected)||a.name.localeCompare(b.name,'ru')).slice(0,30);
 const list=form.querySelector('#house-subproject-choices');if(!list)return;
 list.innerHTML=`<button type="button" data-action="choose-house-subproject" data-id="" class="house-subchoice ${!selected?'chosen':''}">Без подпроекта</button>`+options.map(x=>`<button type="button" data-action="choose-house-subproject" data-id="${esc(x.id)}" class="house-subchoice ${selected===x.id?'chosen':''}"><span>${esc(x.icon||'🔹')} ${esc(x.name)}</span><small>${esc(taxonomy.sections.find(s=>s.id===x.sectionId)?.name||'Раздел')}</small></button>`).join('')+(q&&!options.length?'<span class="house-empty-search">Ничего не найдено</span>':'');
 const pick=taxonomy.subprojects.find(x=>x.id===selected);const chosen=form.querySelector('#house-subproject-selected');
 if(chosen)chosen.textContent=pick?`${pick.icon||'🔹'} ${pick.name} · ${taxonomy.sections.find(s=>s.id===pick.sectionId)?.name||''}`:'Без подпроекта';
}
async function saveHouseTaxonomy(taxonomy){
 const old=state.budgets.find(b=>b.id===HOUSE_TAXONOMY_ID);
 await save('budgets',{...old,id:HOUSE_TAXONOMY_ID,kind:'houseTaxonomy',ownerId:'family',name:'Разделы проекта «Наш дом»',sections:taxonomy.sections,subprojects:taxonomy.subprojects});
 await loadData();render();
}
function houseSectionTotals(rows){
 const result=new Map();for(const t of rows){const k=houseSectionForTx(t);result.set(k,(result.get(k)||0)+netExpense(t));}return result;
}
function houseSubprojectList(rows){
 const tax=houseTaxonomy(),q=state.houseUI.search.trim().toLocaleLowerCase('ru');
 const subs=tax.subprojects.filter(x=>x.active!==false||rows.some(t=>t.houseSubprojectId===x.id))
  .filter(x=>(state.houseUI.section==='all'||state.houseUI.section===x.sectionId)&&(!q||x.name.toLocaleLowerCase('ru').includes(q)||tax.sections.find(s=>s.id===x.sectionId)?.name.toLocaleLowerCase('ru').includes(q)))
  .sort((a,b)=>a.name.localeCompare(b.name,'ru'));
 if(!subs.length)return '<p class="muted small-text">Подпроектов пока нет. Например, создайте «Электрика» в разделе «Работы».</p>';
 return subs.map(x=>{const related=rows.filter(t=>t.houseSubprojectId===x.id),sum=related.reduce((v,t)=>v+netExpense(t),0),selected=state.houseUI.subproject===x.id;
  return `<div class="house-subproject-item ${selected?'selected':''}"><button data-action="house-filter-subproject" data-id="${esc(x.id)}" title="Показать операции"><span class="house-subicon">${esc(x.icon||'🔹')}</span><span class="house-subtext"><b>${esc(x.name)}</b><small>${esc(tax.sections.find(s=>s.id===x.sectionId)?.name||'Раздел')} · ${related.length} операций</small></span><strong>${esc(format(sum))}</strong></button><button class="house-mini-edit" data-action="house-edit-subproject" data-id="${esc(x.id)}" aria-label="Редактировать подпроект ${esc(x.name)}">✎</button></div>`;
 }).join('');
}
function houseFilteredOperations(rows){
 const tax=houseTaxonomy(),q=state.houseUI.search.trim().toLocaleLowerCase('ru');
 return rows.filter(t=>(state.houseUI.section==='all'||houseSectionForTx(t)===state.houseUI.section)&&
 (state.houseUI.subproject==='all'||t.houseSubprojectId===state.houseUI.subproject)&&
 (!q||[cat(t.categoryId)?.name,t.note,t.labels?.join(' '),tax.sections.find(s=>s.id===houseSectionForTx(t))?.name,tax.subprojects.find(x=>x.id===t.houseSubprojectId)?.name].some(x=>String(x||'').toLocaleLowerCase('ru').includes(q))));
}
function houseOperationRows(rows){const filtered=houseFilteredOperations(rows);return filtered.length?premiumTransactionRows(filtered,30):'<p class="muted small-text">Нет расходов по выбранным условиям.</p>';}
function renderHomeProject(){
 const rows=state.transactions.filter(t=>t.projectId==='home'&&t.type==='expense').sort(sortTx),total=rows.reduce((s,t)=>s+netExpense(t),0);
 const month=state.focusMonth,monthly=rows.filter(t=>t.date.startsWith(month)).reduce((s,t)=>s+netExpense(t),0),tax=houseTaxonomy(),totals=houseSectionTotals(rows);
 const cfg=state.budgets.find(b=>b.id==='house-project-v1'),plan=cfg?.limitMinor||0,mortgage=cfg?.mortgageMonthlyMinor||0;
 const sectionButtons=`<button data-action="house-filter-section" data-id="all" class="house-filter-chip ${state.houseUI.section==='all'?'active':''}">Все</button>`+tax.sections.filter(x=>x.active!==false||totals.has(x.id)).map(x=>`<button data-action="house-filter-section" data-id="${esc(x.id)}" class="house-filter-chip ${state.houseUI.section===x.id?'active':''}">${esc(x.icon||'🏡')} ${esc(x.name)}</button>`).join('');
 return `<div class="lux-dashboard house-screen"><section class="lux-panel lux-house-hero"><div class="lux-house-image"><img src="./assets/our-house.webp" alt="Эскиз нашего будущего дома"><div class="lux-house-image-label"><b>Наш дом</b><small>Семейный проект</small></div></div><div class="lux-house-metrics"><div><small>Потрачено</small><strong>${esc(format(total))}</strong></div><div><small>За ${esc(monthTitle(month))}</small><strong>${esc(format(monthly))}</strong></div><div><small>Ипотека / мес.</small><strong>${mortgage?esc(format(mortgage)):'—'}</strong></div></div></section>
 <section class="lux-panel lux-section house-sections-panel"><div class="lux-section-head"><h2>Разделы расходов</h2><button class="text-action" data-action="house-manage-sections">⚙ Управлять</button></div><div class="house-dynamic-sections">${tax.sections.filter(x=>x.active!==false||totals.has(x.id)).map(x=>`<button class="house-dynamic-section" data-action="house-filter-section" data-id="${esc(x.id)}"><span>${esc(x.icon||'🏡')}</span><small>${esc(x.name)}</small><b>${esc(format(totals.get(x.id)||0))}</b></button>`).join('')}</div><div class="lux-quick-actions"><button data-action="house-new-section">＋ Новый раздел</button></div></section>
 <section class="lux-panel lux-section"><div class="lux-section-head"><h2>Бюджет строительства</h2><button class="text-action" data-action="home-settings">Настроить ›</button></div><div class="lux-plan"><span>Потрачено: <b>${esc(format(total))}</b></span><span>План: <b>${plan?esc(format(plan)):'Не задан'}</b></span></div>${cfg?.mortgageDebtMinor?`<p class="muted small-text">Остаток ипотечного долга: <strong>${esc(format(cfg.mortgageDebtMinor))}</strong></p>`:''}${plan?`<div class="lux-progress"><span style="width:${Math.min(100,total/plan*100)}%"></span></div><p class="muted small-text">${Math.round(total/plan*100)}% плана · осталось ${esc(format(Math.max(0,plan-total)))}</p>`:''}</section>
 <section class="lux-panel lux-section house-subprojects-panel"><div class="lux-section-head"><h2>Подпроекты</h2><button class="text-action" data-action="house-new-subproject">＋ Добавить</button></div><label class="house-project-search"><span>⌕</span><input id="house-project-search" type="search" placeholder="Поиск: электрика, окна, сантехника…" value="${esc(state.houseUI.search)}" aria-label="Поиск по проекту" autocomplete="off"></label><div class="house-section-filters">${sectionButtons}</div><div id="house-subproject-grid" class="house-subproject-grid">${houseSubprojectList(rows)}</div><button class="house-link-button" data-action="house-manage-subprojects">Редактировать все подпроекты ›</button></section>
 <section class="lux-panel lux-section"><div class="lux-section-head"><h2>Операции по дому</h2><button class="text-action" data-action="add-home-expense">＋ Расход</button></div><div id="house-operation-list">${houseOperationRows(rows)}</div><div class="lux-quick-actions"><button data-action="add-home-expense">＋ Добавить расход</button><button data-action="home-settings">⚙ Ипотека и план</button></div></section></div>`;
}
function openHouseManager(kind){
 const tax=houseTaxonomy(),sections=kind==='sections',items=sections?tax.sections:tax.subprojects;
 openModal(sections?'Разделы расходов по дому':'Подпроекты дома',`<div class="house-manager"><p class="small-text muted">Можно менять название, значок и видимость. Старые операции сохраняются.</p>${items.map(x=>`<div class="house-manager-row"><span>${esc(x.icon||'🏡')}</span><div><b>${esc(x.name)}</b><small>${x.active===false?'Скрыт':sections?'Раздел':esc(tax.sections.find(s=>s.id===x.sectionId)?.name||'Раздел')}</small></div><button data-action="${sections?'house-edit-section':'house-edit-subproject'}" data-id="${esc(x.id)}">Изменить</button></div>`).join('')||'<p class="muted">Пока пусто</p>'}<button class="lux-main-button" data-action="${sections?'house-new-section':'house-new-subproject'}">＋ ${sections?'Новый раздел':'Новый подпроект'}</button></div>`);
}
function openHouseEditor(kind,id=''){
 const tax=houseTaxonomy(),sections=kind==='sections',old=(sections?tax.sections:tax.subprojects).find(x=>x.id===id);
 const title=sections?(old?'Редактировать раздел':'Новый раздел'):(old?'Редактировать подпроект':'Новый подпроект');
 openModal(title,`<form id="${sections?'house-section-form':'house-subproject-form'}" data-id="${esc(id)}" class="form-grid house-taxonomy-form">
 ${field('Название',`<input name="name" value="${esc(old?.name||'')}" maxlength="90" placeholder="Например, ${sections?'Инженерные сети':'Электрика'}" required>`,true)}
 ${field('Значок (эмодзи)',`<input name="icon" value="${esc(old?.icon|| (sections?'🏡':'⚡'))}" maxlength="12" placeholder="⚡">`,true)}
 ${sections?'':field('Раздел расходов',`<select name="sectionId">${tax.sections.filter(x=>x.active!==false||x.id===old?.sectionId).map(x=>opt(x.id,`${x.icon||'🏡'} ${x.name}`,x.id===(old?.sectionId||'work'))).join('')}</select>`,true)}
 <label class="field wide house-editor-active"><span>Показывать при добавлении расходов</span><input type="checkbox" name="active" ${old?.active===false?'':'checked'}></label>
 <div class="modal-actions wide"><button type="button" class="btn" data-action="${sections?'house-manage-sections':'house-manage-subprojects'}">Назад</button><button class="btn primary" type="submit">Сохранить</button></div></form>`);
}
async function submitHouseEditor(form,kind){
 const tax=houseTaxonomy(),sections=kind==='sections',list=sections?tax.sections:tax.subprojects,old=list.find(x=>x.id===form.dataset.id),f=new FormData(form);
 const name=cleanName(f.get('name')),icon=String(f.get('icon')||'🏡').trim(),active=f.get('active')==='on';
 if(name.length<1||name.length>90)throw Error('Укажите название до 90 символов');
 if(list.some(x=>x.id!==old?.id&&x.name.toLocaleLowerCase('ru')===name.toLocaleLowerCase('ru')))throw Error('Такое название уже есть');
 const sectionId=String(f.get('sectionId')||'');
 if(!sections&&!tax.sections.some(x=>x.id===sectionId))throw Error('Выберите раздел');
 const x={...old,id:old?.id||uid(),name,icon:icon.slice(0,12),active,...(!sections?{sectionId}:{})};
 if(old)list.splice(list.indexOf(old),1,x);else list.push(x);
 await saveHouseTaxonomy(tax);closeModal();toast(sections?'Раздел сохранён.':'Подпроект сохранён.');
}
function openBalanceAdjustment(){
 const wallets=state.wallets.filter(w=>w.status!=='closed'&&w.currency==='RUB');
 openModal('Актуализировать баланс',`<form id="balances-form"><p class="small-text muted">Введите реальные суммы по счетам. Старые операции останутся в истории, а новый баланс будет считаться от момента сверки.</p><div class="balance-adjust-list">${wallets.map(w=>`<label class="balance-adjust-row"><span><b>${esc(w.name)}</b><small>${esc(OWNERS[ownerOfWallet(w)])}</small></span><input inputmode="decimal" type="number" step="0.01" name="wallet_${esc(w.id)}" data-wallet-id="${esc(w.id)}" value="${(balance(w)/100).toFixed(2)}" required></label>`).join('')}</div><div class="tx-entry-actions"><button type="button" class="btn" data-action="close-modal">Отмена</button><button class="btn primary" type="submit">Сохранить остатки</button></div></form>`);
}
async function saveBalanceAdjustment(form){
 const entries=[...form.querySelectorAll('[data-wallet-id]')].map(input=>({w:state.wallets.find(x=>x.id===input.dataset.walletId),n:Math.round(Number(input.value)*100)}));
 if(entries.some(x=>!x.w||!Number.isSafeInteger(x.n)))throw Error('Проверь суммы на счетах');
 if(!confirm('Зафиксировать текущие остатки по всем указанным счетам? История операций останется без изменений.'))return;
 const anchor=new Date().toISOString(),date=today();
 for(const {w,n} of entries)await save('wallets',{...w,balanceAnchorMinor:n,balanceAnchorAt:anchor,balanceAnchorDate:date});
 await loadData();closeModal();render();toast('Остатки актуализированы. История сохранена.');
}
function openHomeSettings(){const x=state.budgets.find(b=>b.id==='house-project-v1');openModal('Наш дом · настройки',`<form id="home-settings-form" class="form-grid"><label class="field wide">Плановый бюджет строительства<input name="plan" inputmode="decimal" type="number" min="0" step="0.01" value="${(x?.limitMinor||0)/100}"></label><label class="field">Ипотека в месяц<input name="mortgage" inputmode="decimal" type="number" min="0" step="0.01" value="${(x?.mortgageMonthlyMinor||0)/100}"></label><label class="field">Остаток долга по ипотеке<input name="debt" inputmode="decimal" type="number" min="0" step="0.01" value="${(x?.mortgageDebtMinor||0)/100}"></label><p class="small-text muted wide">Плановые платежи не создают реальных операций. Каждый расход записывается отдельно, чтобы не было двойного учёта.</p><div class="modal-actions wide"><button class="btn primary" type="submit">Сохранить</button></div></form>`);}
async function saveHomeSettings(form){const f=new FormData(form);const amount=k=>Math.round(Number(f.get(k)||0)*100);const plan=amount('plan'),mortgage=amount('mortgage'),debt=amount('debt');if([plan,mortgage,debt].some(x=>!Number.isSafeInteger(x)||x<0))throw Error('Укажи корректные суммы');await save('budgets',{id:'house-project-v1',kind:'houseProject',ownerId:'family',name:'Наш дом',limitMinor:plan,mortgageMonthlyMinor:mortgage,mortgageDebtMinor:debt});await loadData();closeModal();render();toast('Настройки дома сохранены');}
function openRecurring(){openModal('Ежемесячный расход Матвея',`<form id="recurring-form" class="form-grid"><label class="field wide">Название<input name="name" placeholder="Садик, кружок, развитие" required maxlength="80"></label><label class="field wide">Сумма в месяц<input name="amount" type="number" min="0.01" step="0.01" required></label><div class="modal-actions wide"><button class="btn primary" type="submit">Сохранить</button></div></form>`);}
async function saveRecurring(form){const f=new FormData(form),value=Math.round(Number(f.get('amount'))*100),name=cleanName(f.get('name'));if(!name||!Number.isSafeInteger(value)||value<=0)throw Error('Проверь сумму');await save('budgets',{id:uid(),kind:'recurring',ownerId:'matvey',name,limitMinor:value});await loadData();closeModal();render();toast('Платёж добавлен в план');}

function renderOverview(){
 const w=wallet(),rows=filteredByPeriod(w),income=sumType(rows,'income',w),expense=sumType(rows,'expense',w),cb=cashbackTotals(rows,w);
 return `<div class="page-section"><div class="section-title"><h2>Финансовый обзор</h2><select id="period-picker" aria-label="Период">${opt('month','Выбранный месяц',state.period==='month')}${opt('year','Этот год',state.period==='year')}${opt('all','Вся история',state.period==='all')}</select></div>
 <div class="overview-month-hint">${state.period==='month'?esc(monthTitle(state.focusMonth,true)):state.period==='year'?'С начала года':'За весь период'} · ${rows.length.toLocaleString('ru-RU')} операций</div>
 <div class="stats"><div class="panel stat"><div class="label">Доходы</div><strong class="positive">+${esc(format(income,w.currency))}</strong></div><div class="panel stat"><div class="label">Расходы</div><strong class="negative">−${esc(format(expense,w.currency))}</strong></div><div class="panel stat"><div class="label">Разница</div><strong>${money(income-expense,w.currency)}</strong></div></div>
 <section class="panel cashback-overview"><div class="panel-header"><h2>Выгода от кешбэка</h2><span class="tiny muted">${cb.count} покупок</span></div>
 <div class="cashback-summary"><strong class="positive">+${esc(format(cb.cashback,w.currency))}</strong><span class="tiny muted">Покупки до кешбэка: ${esc(format(cb.gross,w.currency))}</span><span class="tiny muted">Фактические расходы: ${esc(format(expense,w.currency))}</span></div>
 <p class="tiny muted">Выгода учитывается сразу, без ожидания начисления. Баланс счёта отражает полное списание: будущий кешбэк не считается уже полученными деньгами.</p></section>
 <div class="dash-columns"><section class="panel section-gap"><div class="panel-header"><h2>Доходы по категориям</h2><span class="tiny muted">Топ-7</span></div>${categoriesBar(rows,'income',w)}</section>
 <section class="panel section-gap"><div class="panel-header"><h2>Расходы по категориям</h2><span class="tiny muted">Топ-7</span></div>${categoriesBar(rows,'expense',w)}</section></div>
 <section class="panel section-gap"><div class="panel-header"><h2>История</h2><button data-action="show-transactions" class="btn small">Показать операции</button></div><p class="tiny muted">Подробный поиск и фильтры доступны в истории операций.</p></section>
 </div>`;
}
function categoriesBar(rows,type,w){
  const sums=new Map();
  rows.filter(t=>t.type===type&&visibleTx(t,w)).forEach(t=>sums.set(t.categoryId,(sums.get(t.categoryId)||0)+(type==='expense'?netExpense(t):t.amountMinor)));
  const sorted=[...sums].sort((a,b)=>b[1]-a[1]).slice(0,7);
  if(!sorted.length)return '<div class="empty">Пока нет операций за выбранный период</div>';
  const max=sorted[0][1]||1;
  return `<div class="bars">${sorted.map(([id,amount])=>`<div><div class="bar-line"><span>${esc(cat(id)?.name||'Без категории')}</span><span>${esc(format(amount,w.currency))}</span></div><div class="bar-meter"><div class="bar-fill" style="width:${Math.max(2,amount/max*100)}%;background:${esc(cat(id)?.color||'#54bca2')}"></div></div></div>`).join('')}</div>`;
}
function transactionList(){
  const w=wallet(),f=state.txFilters;
  let rows=state.transactions.filter(t=>isWalletTx(t,w)).filter(t=>{
    const name=cat(t.categoryId)?.name||'';
    const search=String(f.search).trim().toLowerCase();
    const delta=Math.abs(displayDelta(t,w));
    return (!search||[name,t.note,(t.labels||[]).join(' ')].join(' ').toLowerCase().includes(search))
      &&(f.category==='all'||t.categoryId===f.category)
      &&(f.kind==='all'||t.type===f.kind)
      &&(!f.from||t.date>=f.from)&&(!f.to||t.date<=f.to)
      &&(!f.min||delta>=Number(f.min)*100)&&(!f.max||delta<=Number(f.max)*100);
  }).sort(sortTx);
  const total=rows.length,view=rows.slice(0,state.maxTx);
  return `<div class="tiny muted results-count">Найдено: ${total.toLocaleString('ru-RU')}</div>${view.length?groupedOperations(view,w,view.length):'<div class="empty"><strong>Операций нет</strong>Измените фильтры или добавьте новую операцию.</div>'}${total>view.length?`<button class="btn more-results" data-action="more-tx">Показать ещё (${(total-view.length).toLocaleString('ru-RU')})</button>`:''}`;
}
function renderTransactions(){ const f=state.txFilters;return `<section class="panel"><div class="panel-header"><h2>История операций</h2><div class="inline-actions"><button class="btn small" data-action="scan-expense">📷 Со скриншота</button><button class="btn primary small" data-action="add-tx">+ Новая</button></div></div>
  <div class="toolbar"><input id="tx-search" placeholder="Категория, заметка, метка…" value="${esc(f.search)}" autocomplete="off"/>
  <select id="tx-kind">${opt('all','Все типы',f.kind==='all')}${opt('income','Доходы',f.kind==='income')}${opt('expense','Расходы',f.kind==='expense')}</select>
  <select id="tx-category">${categoryOptions('all',f.category,true)}</select></div>
  <div class="toolbar"><input id="tx-from" type="date" aria-label="Дата с" value="${esc(f.from)}"/><input id="tx-to" type="date" aria-label="Дата по" value="${esc(f.to)}"/><input id="tx-min" type="number" min="0" step="0.01" placeholder="Сумма от" value="${esc(f.min)}"/><input id="tx-max" type="number" min="0" step="0.01" placeholder="Сумма до" value="${esc(f.max)}"/><button class="btn small" data-action="clear-filters">Сбросить</button></div>
  <div id="tx-list">${transactionList()}</div></section>`; }
function renderBudgets(){
  const w=wallet(),currentMonth=today().slice(0,7),relevant=state.budgets.filter(b=>b.kind!=='houseProject'&&b.kind!=='houseTaxonomy'&&b.kind!=='recurring'&&(state.profileId==='family'||(b.ownerId||ownerOfWallet(state.wallets.find(x=>x.id===b.walletId)))===state.profileId));
  return `<section class="panel section-gap"><div class="panel-header"><div><h2>Лимиты расходов</h2><p class="tiny muted" style="margin:7px 0 0">Текущий месяц · по владельцу расхода, независимо от карты оплаты</p></div><button class="btn primary small" data-action="add-budget">+ Бюджет</button></div>
  ${relevant.length?relevant.map(b=>{
    const used=state.transactions.filter(t=>ownerOfTx(t)===(b.ownerId||ownerOfWallet(state.wallets.find(x=>x.id===b.walletId)))&&t.type==='expense'&&walletCurrencyMatches(t,w)&&t.date.startsWith(currentMonth)&&(!b.categoryId||t.categoryId===b.categoryId)).reduce((s,t)=>s+netExpense(t),0);
    const ratio=used/b.limitMinor;
    return `<div class="budget-item"><div class="bar-line"><span>${esc(b.name)}</span><span>${Math.round(ratio*100)}%</span></div>
    <div class="tiny muted" style="margin:8px 0 12px">${esc(format(used,w.currency))} из ${esc(format(b.limitMinor,w.currency))} · ${esc(cat(b.categoryId)?.name||'Все расходы')}</div>
    <div class="progress"><div class="progress-fill ${ratio>=1?'over':ratio>=.75?'warning':''}" style="width:${Math.min(100,ratio*100)}%"></div></div><div class="actions-right" style="margin-top:10px"><button class="btn small" data-action="edit-budget" data-id="${esc(b.id)}">Изменить</button><button class="btn small danger" data-action="delete-budget" data-id="${esc(b.id)}">Удалить</button></div></div>`;}).join(''):'<div class="empty"><strong>Пока нет бюджетов</strong>Создайте месячный лимит расходов на категорию или все расходы.</div>'}</section>`;
}
function renderCloudPanel(){
 const c=cloud.status();
 const error=c.lastError?`<div class="cloud-error" role="alert">${esc(c.lastError)}</div>`:'';
 const header=`<section class="panel cloud-panel"><div class="panel-header"><h2>Семейный аккаунт</h2><span class="sync-status ${c.active?'sync-on':'sync-off'}">${c.active?'● Подключён':'○ Не синхронизируется'}</span></div>${error}`;
 if(!c.signedIn)return `${header}
 <form id="cloud-auth-form" class="form-grid"><label class="field">Электронная почта<input type="email" name="email" autocomplete="username" required></label><label class="field">Пароль<input type="password" name="password" autocomplete="current-password" minlength="6" required></label>
 <div class="cloud-actions"><button class="btn primary" type="submit" name="cloudMode" value="login">Войти</button><button class="btn" type="submit" name="cloudMode" value="register">Регистрация</button></div></form></section>`;
 if(!c.family)return `${header}<div class="cloud-account-row"><span>${esc(c.email)}</span><button class="btn small" data-action="cloud-logout">Выйти</button></div>
 <div class="cloud-actions"><button class="btn primary" data-action="cloud-list-families">Открыть семейный бюджет</button></div>
 <form id="cloud-create-form" class="form-grid cloud-subform"><label class="field">Название семьи<input name="familyName" value="Наша семья" required maxlength="100"></label><button class="btn" type="submit">Создать семью</button></form>
 <form id="cloud-join-form" class="form-grid cloud-subform"><label class="field">Код приглашения<input name="invite" minlength="48" maxlength="48" required></label><button class="btn" type="submit">Присоединиться</button></form></section>`;
 return `${header}<div class="cloud-account-row"><span>${esc(c.email)}</span><button class="btn small" data-action="cloud-logout">Выйти</button></div>
 ${c.active?
 `<div class="cloud-actions"><button class="btn primary" data-action="cloud-sync" ${c.busy?'disabled':''}>${c.busy?'Обновляем…':'Обновить данные'}</button><button class="btn" data-action="cloud-invite">Пригласить жену</button></div>${c.lastSyncAt?`<p class="cloud-timestamp">Последняя проверка: ${new Date(c.lastSyncAt).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})}</p>`:''}`:
 `<p class="cloud-notice">Вход выполнен, но обмен между устройствами пока не включён.</p>
 <div class="cloud-actions"><button class="btn primary" data-action="cloud-start">Включить синхронизацию</button><button class="btn" data-action="cloud-invite">Пригласить жену</button></div>`}
 </section>`;
}
function renderSettings(){
 const w=wallet();const income=state.categories.filter(c=>c.type==='income').length,expense=state.categories.filter(c=>c.type==='expense').length;
 return `${renderCloudPanel()}<section class="panel section-gap import-main"><div class="panel-header"><h2>📥 Импортировать мои данные</h2></div>

 <label class="field" for="data-import-file">Выбрать файл с телефона или компьютера
 <input type="file" id="data-import-file" accept=".json,.csv,application/json,text/csv,text/plain" aria-describedby="data-import-help" /></label>

 </section>
 <div class="grid-two"><section class="panel"><div class="panel-header"><h2>Семейный бюджет и телефон</h2></div>
 <label class="field">Чей это телефон по умолчанию?<select id="device-owner">${ownerOptions(state.deviceOwner)}</select></label>
 <button class="btn" data-action="switch-device-profile">Показать свой бюджет</button></section>
 <section class="panel"><div class="panel-header"><h2>Данные и устройство</h2></div><button class="btn" data-action="go-accounts">Перейти к счетам</button><button class="btn" data-action="show-budgets">Лимиты расходов</button><button class="btn" data-page="house">Наш дом</button><div class="settings-stat">${state.transactions.length.toLocaleString('ru-RU')} операций · ${state.wallets.length} счетов</div></section>
 <section class="panel lux-category-entry"><div class="panel-header"><h2>Категории и иконки</h2><button class="btn small primary" data-action="open-categories">Управлять ›</button></div><p class="tiny muted">${income} доходных · ${expense} расходных. Скрывай устаревшие категории без изменения истории и баланса.</p></section>
 <section class="panel"><div class="panel-header"><h2>Резервная копия</h2></div><div class="setting-block"><button class="btn primary" data-action="backup-json">Скачать полную копию JSON</button><button class="btn" data-action="export-csv">Экспорт операций CSV</button></div></section>
 </div>`;
}
const CATEGORY_ICON_GROUPS={
 'Доходы':['💰','💵','💳','👤','🧑‍💼','💼','🏦','📈','🎁','⭐','🪙','📦'],
 'Покупки':['🛒','🛍️','🍎','🥗','🍽️','☕','👟','👕','🧴','🧸','💊','🎮'],
 'Дом и семья':['🏡','🏠','🧱','🔨','🛠️','🪑','💡','⚡','💧','👨‍👩‍👦','👶','🎒'],
 'Жизнь':['🚗','🚙','⛽','🚕','🚆','✈️','🏝️','💗','🐾','🎂','🎓','🏥','📱'],
 'Другое':['📃','🧾','📚','🎬','🎉','🎧','🏋️','📌','📊','🗝️','💎','🪴','❓']
};
const CATEGORY_ICONS=new Set(Object.values(CATEGORY_ICON_GROUPS).flat());
const safeCategoryColor=c=>/^#[0-9a-f]{6}$/i.test(c?.color||'')?c.color:'#c59e79';
function categoryUsage(){const counts=new Map();for(const t of state.transactions)if(t.categoryId)counts.set(t.categoryId,(counts.get(t.categoryId)||0)+1);return counts;}
function categoryManagerItems(){
 const {type,view,sort,search}=state.catUI,counts=categoryUsage(),q=search.trim().toLocaleLowerCase('ru');
 const filtered=state.categories.filter(c=>c.type===type&&c.name.toLocaleLowerCase('ru').includes(q)&&(view==='all'||(view==='hidden'?isCategoryHidden(c):!isCategoryHidden(c))))
   .sort((a,b)=>sort==='alpha'?a.name.localeCompare(b.name,'ru'):(counts.get(b.id)||0)-(counts.get(a.id)||0)||a.name.localeCompare(b.name,'ru'));
 if(!filtered.length)return '<div class="cat-manage-empty">Ничего не найдено. Попробуй другой фильтр.</div>';
 return filtered.map(c=>{const hidden=isCategoryHidden(c),n=counts.get(c.id)||0,color=safeCategoryColor(c);
   return `<article class="cat-manage-row" data-category-id="${esc(c.id)}">
     <span class="cat-manage-icon" style="--category-color:${color}" aria-hidden="true">${esc(iconForCategory(c))}</span>
     <div class="cat-manage-name"><strong>${esc(c.name)}</strong><small>${n.toLocaleString('ru-RU')} операций за всё время</small></div>
     <button type="button" class="cat-manage-edit" data-action="edit-category" data-id="${esc(c.id)}" aria-label="Редактировать ${esc(c.name)}">✎</button>
     <button type="button" class="cat-switch ${hidden?'is-off':'is-on'}" data-action="toggle-category" data-id="${esc(c.id)}" aria-pressed="${!hidden}" aria-label="${hidden?'Показывать':'Скрыть'} при добавлении: ${esc(c.name)}"><span class="cat-switch-track"><span></span></span><span class="cat-switch-label">${hidden?'Скрыта':'Активна'}</span></button>
   </article>`;}).join('');
}
function renderCategories(){
 const ui=state.catUI,active=state.categories.filter(c=>c.type===ui.type&&!isCategoryHidden(c)).length,hidden=state.categories.filter(c=>c.type===ui.type&&isCategoryHidden(c)).length;
 return `<div class="category-manager">
 <header class="cat-manage-header"><button class="cat-manage-back" data-action="back-to-settings">‹ Больше</button><button class="btn primary" data-action="add-category">＋ Новая</button></header>
 <div class="cat-manage-hero"><div><span class="cat-manage-eyebrow">МОИ КАТЕГОРИИ</span><h2>Категории</h2><p>Иконки, порядок и видимость при добавлении операций</p></div><span class="cat-manage-hero-icon" aria-hidden="true">✦</span></div>
 <div class="cat-manage-type" role="group" aria-label="Тип категорий"><button class="${ui.type==='expense'?'active':''}" data-action="category-type" data-type="expense">↗ Расходы</button><button class="${ui.type==='income'?'active':''}" data-action="category-type" data-type="income">↘ Доходы</button></div>
 <label class="cat-manage-search"><span aria-hidden="true">⌕</span><input id="category-manager-search" type="search" placeholder="Найти категорию…" value="${esc(ui.search)}" autocomplete="off" aria-label="Поиск категории"></label>
 <div class="cat-manage-tools"><div class="cat-manage-views" role="group" aria-label="Видимость категорий">${[['active','Активные'],['hidden','Скрытые'],['all','Все']].map(([v,label])=>`<button data-action="category-view" data-view="${v}" class="${ui.view===v?'active':''}">${label}</button>`).join('')}</div><label class="cat-manage-sort">Сортировка<select id="category-manager-sort">${opt('frequent','По частоте',ui.sort==='frequent')}${opt('alpha','По алфавиту',ui.sort==='alpha')}</select></label></div>
 <div class="cat-manage-summary"><b>${active}</b> активных · <b>${hidden}</b> скрытых <span>· ${esc(OWNERS[state.profileId])}</span></div>
 <section id="categories-results" class="cat-manage-results" aria-label="Список категорий">${categoryManagerItems()}</section>
 <p class="cat-manage-note">Скрытые категории остаются в истории, аналитике и резервных копиях. Видимость настраивается отдельно для каждого профиля и синхронизируется между устройствами.</p>
 </div>`;
}
function setPage(page){state.page=page;state.maxTx=100;render();window.scrollTo(0,0);}
function openModal(title,body){$('#modal-root').innerHTML=`<div class="modal-backdrop" data-action="backdrop"><div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="modal-head"><h2>${esc(title)}</h2><button class="close" data-action="close-modal" aria-label="Закрыть">×</button></div>${body}</div></div>`;}
function closeModal(){$('#modal-root').innerHTML='';}
function field(title,html,wide=false){return `<label class="field ${wide?'wide':''}">${esc(title)}${html}</label>`;}
let editingType='expense';
function cashbackFields(t){
 const cashback=benefit(t||{});
 return `<div class="cashback-fields wide" id="tx-cashback-wrap">
   <div class="cashback-heading">🎁 Кешбэк с покупки</div>
   <p class="tiny muted">Укажите процент или сумму. Выгода сразу уменьшит расход, ждать начисления не нужно.</p>
   <div class="cashback-inputs">
     ${field('Кешбэк, %',`<input type="number" name="cashbackPercent" min="0" max="100" step="0.01" inputmode="decimal" value="${t?.amountMinor&&cashback?+(cashback/t.amountMinor*100).toFixed(2):0}">`)}
     ${field('Кешбэк, сумма',`<input type="number" name="cashbackAmount" min="0" step="0.01" inputmode="decimal" value="${(cashback/100).toFixed(2)}">`)}
   </div>
   <div class="cashback-preview" id="cashback-preview">Расход после кешбэка: —</div>
   <p class="tiny muted">В «Счетах» учитывается полное списание из банка, а в «Расходах» — сумма за вычетом кешбэка.</p>
 </div>`;
}
function updateCashbackPreview(form, source='amount'){
 if(!form)return;
 const gross=Math.round(Number(form.elements.amount?.value||0)*100),pct=form.elements.cashbackPercent,amount=form.elements.cashbackAmount;
 if(!pct||!amount)return;
 if(source==='percent'||source==='gross'||source==='cashbackAmount'){
  if(source==='percent'||source==='gross')amount.value=(Math.round(gross*Math.max(0,Number(pct.value||0))/100)/100).toFixed(2);
  else if(source==='cashbackAmount'&&gross>0)pct.value=(Math.max(0,Number(amount.value||0))*10000/gross).toFixed(2);
 }
 const cashback=Math.round(Number(amount.value||0)*100),preview=form.querySelector('#cashback-preview');
 if(preview)preview.textContent=`Расход после кешбэка: ${format(Math.max(0,gross-cashback),state.wallets.find(w=>w.id===form.elements.wallet?.value)?.currency||'RUB')} · выгода ${format(cashback)}`;
}
function cashbackFormData(form,gross,existing=null){
 const cashback=Math.round(Number(form.elements.cashbackAmount?.value||0)*100);
 if(!Number.isSafeInteger(cashback)||cashback<0||cashback>gross)return null;
 // Legacy confirmation fields are preserved when editing older records, but
 // new purchases never require a cashback-receipt confirmation.
 return {cashbackMinor:cashback,
         cashbackStatus:existing?.cashbackStatus==='received'?'received':'expected',
         cashbackDate:existing?.cashbackStatus==='received'?existing.cashbackDate||existing.date:null};
}

function amountTextFromMinor(minor){
 const whole=Math.floor((minor||0)/100),cents=Math.abs(minor||0)%100;
 return cents?`${whole},${String(cents).padStart(2,'0')}`:String(whole);
}
function normalizeKeypadAmount(value){
 const normalized=String(value||'').replace(/\s/g,'').replace('.',',').replace(/[^0-9,]/g,'');
 const [whole='',fraction='']=normalized.split(',');
 return `${(whole.replace(/^0+(?=\d)/,'')||'0').slice(0,12)}${normalized.includes(',')?','+fraction.slice(0,2):''}`;
}
function renderKeypadAmount(){
 const input=$('#tx-form [name=amount]'),display=$('#keypad-value');if(!input||!display)return;
 const value=normalizeKeypadAmount(input.value);input.value=value;
 display.textContent=value.replace('.',',')+' ₽';
 updateCashbackPreview($('#tx-form'),'gross');
}
function useKeypadKey(key){
 const input=$('#tx-form [name=amount]');if(!input)return;
 let v=String(input.value||'0').replace('.',',');
 if(key==='back')v=v.slice(0,-1)||'0';
 else if(key==='clear')v='0';
 else if(key===','){if(!v.includes(','))v+=',';}
 else if(/^\d$/.test(key)){if((v.split(',')[1]||'').length>=2&&v.includes(','))return;v=v==='0'?key:v+key;}
 else return;
 input.value=normalizeKeypadAmount(v);renderKeypadAmount();
}
function keypadMarkup(amountMinor=0){
 const items=['1','2','3','4','5','6','7','8','9',',','0','back'];
 return `<section class="tx-keypad-panel"><div class="tx-amount-caption">Сумма операции</div>
 <div class="tx-big-amount" id="keypad-value" aria-live="polite">${esc(amountTextFromMinor(amountMinor))} ₽</div>
 <div class="tx-keypad" aria-label="Ввести сумму">${items.map(x=>`<button type="button" class="tx-key ${x==='back'?'tx-key-back':''}" data-action="keypad-key" data-key="${x}" aria-label="${x==='back'?'Удалить цифру':x}">${x==='back'?'⌫':x}</button>`).join('')}</div>
 </section>`;
}
function openTransaction(id,preferredType='expense',presetCategory=''){
 const t=state.transactions.find(x=>x.id===id);editingType=t?.type||preferredType;
 const pendingRecurring=!t&&editingType==='expense'?state.pendingRecurring:null;
 const homeDefault=Boolean(t?.projectId==='home'||(!t&&state.pendingHomeExpense));
 const w=state.wallets.find(x=>x.id===t?.walletId)||wallet();
 const category=state.categories.find(c=>c.id===(t?.categoryId||presetCategory));
 const typeButtons=editingType==='transfer'?[['transfer','Перевод'],['expense','Расход'],['income','Доход']]:[['expense','Расход'],['income','Доход']];
 const body=`<form id="tx-form" data-id="${esc(t?.id||'')}">
 <div class="tx-entry-heading"><span class="tx-entry-icon">${category?iconForCategory(category):editingType==='income'?'↗':'↘'}</span>
 <span class="tx-entry-category">${esc(category?.name||'Без категории')}</span>${homeDefault?'<span class="tx-home-badge">🏡 Дом</span>':''}</div>
 <div class="type-tabs tx-entry-types">${typeButtons.map(([type,label])=>`<button type="button" class="type-tab ${editingType===type?'active':''}" data-action="type-tab" data-type="${type}">${label}</button>`).join('')}</div>
 <input name="amount" type="hidden" value="${t?esc(amountTextFromMinor(t.amountMinor)):pendingRecurring?esc(amountTextFromMinor(pendingRecurring.limitMinor)):'0'}">
 ${keypadMarkup(t?.amountMinor||pendingRecurring?.limitMinor||0)}
 <div class="tx-entry-date"><span>Дата</span><input name="date" type="date" value="${esc(t?.date||today())}" required></div>
 <details class="tx-extra" ${t?'open':''}><summary>Детали операции</summary><div class="tx-extra-content">
 <label class="field ${editingType==='income'?'hidden':''}" id="tx-wallet-wrap">Оплачено с карты / счёта<select name="wallet">${walletOptions(w.id)}</select></label>
 <label class="field" id="tx-owner-wrap">${editingType==='income'?'Чей доход':'Чей расход'}<select name="owner">${ownerOptions(t?ownerOfTx(t):(state.profileId==='family'?state.deviceOwner:state.profileId),true)}</select></label>
 <div id="tx-cashback-container" class="${editingType==='expense'?'':'hidden'}">${cashbackFields(t)}</div>
 <div id="tx-category-wrap">${field('Категория',`<select name="category"><option value="">Без категории</option>${categoryOptions(editingType,t?.categoryId||presetCategory,false,true)}</select>`)}</div>
 <div class="field ${editingType==='transfer'?'':'hidden'}" id="tx-destination">${field('В какой кошелёк',`<select name="toWallet"><option value="">Выберите</option>${walletOptions(t?.toWalletId||'', x=>x.id!==w.id&&x.currency===w.currency)}</select>`)}</div>
 ${field('Заметка',`<input name="note" maxlength="500" value="${esc(t?.note||pendingRecurring?.name||'')}" placeholder="Необязательно">`)}
 <div id="tx-house-wrap" class="tx-house-field ${editingType==='expense'?'':'hidden'}"><label class="house-check"><input type="checkbox" name="houseProject" ${homeDefault?'checked':''}><span>🏡 Отнести к проекту «Наш дом»</span></label><div class="house-tx-fields ${homeDefault?'':'hidden'}" id="house-tx-fields"><label class="field">Раздел расходов<select name="houseSection">${houseSectionsOptions(t?.houseSection||'other')}</select></label><label class="field">Найти подпроект<input type="search" id="house-subproject-search" placeholder="Например, электрика…" autocomplete="off"></label><input type="hidden" name="houseSubproject" value="${esc(t?.houseSubprojectId||'')}"><div id="house-subproject-selected" class="house-selected-subproject">Без подпроекта</div><div id="house-subproject-choices" class="house-subproject-choices"></div></div></div>
 ${field('Метки',`<input name="labels" value="${esc((t?.labels||[]).join(', '))}" placeholder="Необязательно">`)}</div></details>
 <div class="tx-entry-actions">${t?`<button type="button" class="btn danger" data-action="delete-tx" data-id="${esc(t.id)}">Удалить</button>`:''}<button class="btn primary" type="submit">Сохранить</button></div></form>`;
 openModal(t?'Изменить операцию':'Новая операция',body);
 updateTransactionType(true);
 renderKeypadAmount();
 houseSubprojectChoices();
}
function updateTransactionType(preserveCategory=false){
 document.querySelectorAll('.type-tab').forEach(b=>b.classList.toggle('active',b.dataset.type===editingType));
 const wrap=$('#tx-category-wrap'),dest=$('#tx-destination'),w=$('#tx-wallet-wrap'),cb=$('#tx-cashback-container');if(!wrap)return;
 wrap.classList.toggle('hidden',editingType==='transfer');dest?.classList.toggle('hidden',editingType!=='transfer');
 w?.classList.toggle('hidden',editingType==='income');cb?.classList.toggle('hidden',editingType!=='expense');document.querySelector('#tx-house-wrap')?.classList.toggle('hidden',editingType!=='expense');
 const ownerLabel=$('#tx-owner-wrap');if(ownerLabel)ownerLabel.firstChild.textContent=editingType==='income'?'Чей доход':'Чей расход';
 const catInput=wrap.querySelector('select');if(catInput){const selected=preserveCategory?catInput.value:'';catInput.innerHTML='<option value="">Без категории</option>'+categoryOptions(editingType,selected,false,true);}
}

let quickType='income';
const iconForCategory=c=>{
 const n=c.name.toLocaleLowerCase('ru');
 if(CATEGORY_ICONS.has(c.icon))return c.icon;
 if(/^(2?вк|работ|клиент|заказчик|покупател|зарплат|фриланс|услуг)/.test(n))return '👤';
 if(/процент|вклад|инвест|дивиден|пассив/.test(n))return '💰';
 if(/продукт|еда|магазин|пятёр|перекр|супермар|овощ/.test(n))return '🛒';
 if(/аптек|здоров|врач|медицин/.test(n))return '💊';
 if(/транспорт|бензин|такси|авто|машин/.test(n))return '🚙';
 if(/подар|семь|любов|дет/.test(n))return '💗';
 if(/дом|квартир|коммунал|жиль/.test(n))return '🏠';
 if(/кафе|ресторан|обед/.test(n))return '🍽️';
 if(/одежд|обув/.test(n))return '👟';
 if(/связь|интернет|телефон/.test(n))return '📱';
 if(/развлеч|кино|игр|отдых/.test(n))return '🎉';
 return c.type==='income'?'👤':'🧾';
};
function quickCategoryItems(query=''){
 const counts=new Map();
 for(const t of state.transactions){if(t.type===quickType&&t.categoryId)counts.set(t.categoryId,(counts.get(t.categoryId)||0)+1);}
 const q=String(query).trim().toLocaleLowerCase('ru');
 const list=state.categories.filter(c=>c.type===quickType&&!isCategoryHidden(c)&&c.name.toLocaleLowerCase('ru').includes(q))
   .sort((a,b)=>(counts.get(b.id)||0)-(counts.get(a.id)||0)||a.name.localeCompare(b.name,'ru'));
 return list.map(c=>`<button class="quick-cat" type="button" data-action="choose-quick-category" data-id="${esc(c.id)}" title="${esc(c.name)} · ${(counts.get(c.id)||0)} операций">
   <span class="quick-cat-icon" style="--cat-color:${/^#[0-9a-fA-F]{6}$/.test(c.color)?c.color:'#6e9fc9'}">${iconForCategory(c)}</span>
   <span class="quick-cat-name">${esc(c.name)}</span><span class="quick-cat-count">${(counts.get(c.id)||0).toLocaleString('ru-RU')}</span></button>`).join('')||'<div class="empty">Категории не найдены. Добавь её в «Больше» или измени поиск.</div>';
}
function openQuickAdd(type='income'){
 quickType=type;
 openModal('Новая операция',`<div class="quick-categories">
   <div class="category-tabs"><button data-action="quick-type" data-type="expense" class="${quickType==='expense'?'active':''}">Расходы</button><button data-action="quick-type" data-type="income" class="${quickType==='income'?'active':''}">Доходы</button></div>
   <label class="category-find">🔎 <input id="quick-category-search" type="search" autocomplete="off" placeholder="Найти категорию…" aria-label="Поиск категории" /></label>
   <div class="quick-category-meta">Сначала самые частые категории за всё время</div>
   <div class="quick-category-grid" id="quick-category-grid">${quickCategoryItems()}</div>
   <div class="quick-category-actions"><button class="btn" data-action="quick-no-category">Без категории</button><button class="btn" data-action="scan-expense">📷 Со скриншота</button></div>
 </div>`);

}
function refreshQuickCategoryPicker(){
 const f=$('#quick-category-grid'),q=$('#quick-category-search');if(!f)return;
 document.querySelectorAll('.category-tabs button').forEach(b=>b.classList.toggle('active',b.dataset.type===quickType));
 if(quickType==='transfer'){
  f.innerHTML='<div class="quick-transfer-hint">Перевод денег между своими счетами не считается доходом или расходом. Нажми ниже «Продолжить».</div>';
  $('.quick-category-meta').textContent='Перевод не относится к категориям';
  $('.quick-category-actions').innerHTML='<button class="btn primary" data-action="quick-transfer">Продолжить к переводу</button>';
  q.closest('.category-find').classList.add('hidden');
 }else{
  f.innerHTML=quickCategoryItems(q.value);
  $('.quick-category-meta').textContent='Сначала самые частые категории за всё время';
  $('.quick-category-actions').innerHTML='<button class="btn" data-action="quick-no-category">Без категории</button><button class="btn" data-action="scan-expense">📷 Со скриншота</button>';
  q.closest('.category-find').classList.remove('hidden');
 }
}
function openScreenshotExpense(){
 const w=wallet();
 openModal('Расход со скриншота', `<p class="muted tiny">Загрузите один банковский расход. Плашка «+58 ₽» под суммой покупки в Т‑Банке считается кешбэком: чистый расход вычисляется сразу. OCR бесплатный и работает на устройстве, перед сохранением проверьте распознанные цифры.</p>
 <label class="field">Скриншот (PNG, JPG, WEBP)<input type="file" id="ocr-image" accept="image/png,image/jpeg,image/webp,image/*" /></label>
 <div id="ocr-status" class="hint" style="margin-top:12px">Выберите изображение. Для первой загрузки OCR нужен интернет.</div>
 <form id="ocr-expense-form" class="hidden" style="margin-top:17px">
 <div class="form-grid">
 ${field('Стоимость покупки',`<input required name="amount" type="number" min="0.01" step="0.01" inputmode="decimal" placeholder="0.00">`)}
 ${cashbackFields(null)}
 ${field('Дата',`<input required name="date" type="date" value="${today()}">`)}
 ${field('Оплачено с карты / счёта',`<select name="wallet">${walletOptions(w.id)}</select>`)}
 ${field('Чей расход',`<select name="owner">${ownerOptions(state.profileId==='family'?state.deviceOwner:state.profileId,true)}</select>`)}
 ${field('Категория',`<select name="category"><option value="">Без категории</option>${categoryOptions('expense','',false,true)}</select>`)}
 ${field('Магазин / заметка',`<input name="note" maxlength="500" placeholder="Например, продукты"/>`,true)}
 </div>
 <details class="ocr-details"><summary>Посмотреть распознанный текст</summary><pre id="ocr-raw"></pre></details>
 <div class="modal-actions"><button type="button" class="btn" data-action="close-modal">Отмена</button><button type="submit" class="btn primary">Сохранить расход</button></div>
 </form>`);
}
async function scanExpenseImage(file){
 const form=$('#ocr-expense-form'),status=$('#ocr-status');
 if(!form||!status)return;
 form.classList.add('hidden');
 status.textContent='Загружаем движок распознавания…';
 try{
  const raw=await recognizeImage(file, message=>{if(status.isConnected)status.textContent=message;});
  if(!status.isConnected)return;
  const parsed=parseScreenshot(raw,today());
  const f=$('#ocr-expense-form');if(!f)return;
  f.elements.amount.value=parsed.amount||'';
  f.elements.cashbackAmount.value=(parsed.cashback||0).toFixed(2);
  f.elements.date.value=parsed.date;
  f.elements.note.value=parsed.merchant.slice(0,500);
  $('#ocr-raw').textContent=raw||'(Текст не обнаружен)';
  status.textContent=parsed.amount?(parsed.cashback?`Распознано: покупка ${parsed.amount.toLocaleString('ru-RU')} ₽, кешбэк +${parsed.cashback.toLocaleString('ru-RU')} ₽, расход ${parsed.netAmount.toLocaleString('ru-RU')} ₽. Проверьте перед сохранением.`:'Покупка распознана. Кешбэк не найден — если на снимке есть маленькая сумма возврата, впишите её вручную.'):'Сумма не найдена. Введите её вручную, сверившись со скриншотом.';
  f.classList.remove('hidden');updateCashbackPreview(f,'cashbackAmount');
 }catch(e){if(status.isConnected)status.textContent='Ошибка распознавания: '+e.message+' Попробуйте другое изображение или добавьте расход вручную.';}
}
async function submitOcrExpense(form){
 const data=new FormData(form),amount=Math.round(Number(data.get('amount'))*100);
 const w=state.wallets.find(x=>x.id===data.get('wallet'));
 const date=String(data.get('date'));
 if(!Number.isSafeInteger(amount)||amount<=0||!w||!parseDate(date))return toast('Проверьте сумму, дату и кошелёк.');
 const note=cleanName(data.get('note'));
 const cashback=cashbackFormData(form,amount);if(!cashback)return toast('Кешбэк не может быть больше стоимости покупки.');
 // A soft warning prevents accidental duplicates without blocking valid repeated purchases.
 const duplicate=state.transactions.some(t=>t.type==='expense'&&t.walletId===w.id&&t.date===date&&t.amountMinor===amount&&cleanName(t.note).toLowerCase()===note.toLowerCase());
 if(duplicate&&!confirm('Очень похожий расход уже есть. Сохранить ещё один?'))return;
 await save('transactions',{id:uid(),type:'expense',walletId:w.id,ownerId:String(data.get('owner')||state.deviceOwner),toWalletId:null,amountMinor:amount,...cashback,toAmountMinor:null,date,categoryId:String(data.get('category')||'')||null,note,labels:['скриншот'],createdAt:new Date().toISOString()});
 await loadData();closeModal();render();toast('Расход добавлен в статистику.');
}

function openBudget(id){
 const b=state.budgets.find(x=>x.id===id),w=wallet();
 openModal(b?'Изменить бюджет':'Новый бюджет',`<form id="budget-form" data-id="${esc(id||'')}" class="form-grid">
 ${field('Название',`<input name="name" value="${esc(b?.name||'')}" placeholder="Например, маркетинг" required>`,true)}
 ${field('Лимит за месяц',`<input name="limit" type="number" min="0.01" step="0.01" inputmode="decimal" value="${b?esc(b.limitMinor/100):''}" required>`)}
 ${field('Для чьего бюджета',`<select name="owner">${ownerOptions(b?.ownerId||ownerOfWallet(state.wallets.find(x=>x.id===b?.walletId))||(state.profileId==='family'?state.deviceOwner:state.profileId),true)}</select>`)}
 ${field('Кошелёк-ориентир',`<select name="wallet">${walletOptions(b?.walletId||w.id)}</select>`)}
 ${field('Категория',`<select name="category">${opt('','Все расходы',!b?.categoryId)}${categoryOptions('expense',b?.categoryId||'')}</select>`,true)}
 <div class="modal-actions wide"><button type="button" class="btn" data-action="close-modal">Отмена</button><button class="btn primary" type="submit">Сохранить</button></div></form>`);
}
function openWallet(id){
 const w=state.wallets.find(x=>x.id===id);
 const hasHistory=Boolean(w&&(state.transactions.some(t=>t.walletId===w.id||t.toWalletId===w.id)||state.budgets.some(b=>b.walletId===w.id)));
 openModal(w?'Редактировать кошелёк':'Новый кошелёк',`<form id="wallet-form" data-id="${esc(id||'')}" class="form-grid">
 ${field('Название',`<input name="name" value="${esc(w?.name||'')}" required>`,true)}
 ${field('Валюта',`<select name="currency" ${w?'disabled':''}>${['RUB','EUR','USD','GBP','KZT','BYN','UAH'].map(v=>opt(v,v,v===(w?.currency||'RUB'))).join('')}</select>`)}
 ${field('Владелец счёта',`<select name="owner">${ownerOptions(w?ownerOfWallet(w):(state.profileId==='family'?state.deviceOwner:state.profileId),true)}</select>`)}
 ${field('Начальный баланс',`<input name="initial" type="number" step="0.01" value="${w?esc((w.initialBalanceMinor||0)/100):'0'}" required>`)}
 ${w?.kind==='deposit'?`${field('Банк',`<input name="bank" maxlength="80" value="${esc(w.bank||'')}" required>`)}${field('Ставка годовых, %',`<input name="rate" type="number" min="0" max="100" step="0.01" value="${esc(w.rate||0)}">`)}${field('Дата окончания',`<input name="maturityDate" type="date" value="${esc(w.maturityDate||'')}">`)}${field('Состояние',`<select name="status">${opt('open','Действует',w.status!=='closed')}${opt('closed','Архивный / закрыт',w.status==='closed')}</select>`)}`:''}
 <p class="tiny muted wide">Начальный баланс — сумма до первой внесённой операции. После импорта истории обычно равен 0, если данные полные.</p>
 <div class="modal-actions wide"><button type="button" class="btn" data-action="close-modal">Отмена</button><button class="btn primary" type="submit">Сохранить</button></div>
 ${w?`<div class="wallet-manage-actions wide">${w.status==='closed'?`<button type="button" class="btn" data-action="restore-wallet" data-id="${esc(w.id)}">↺ Восстановить из архива</button>`:''}${w.status==='closed'&&hasHistory?'':`<button type="button" class="btn danger" data-action="delete-wallet" data-id="${esc(w.id)}">${w.status==='closed'?'Удалить окончательно':hasHistory?'В архив':'Удалить счёт'}</button>`}</div>`:''}</form>`);
}
// Deletion is safe only for a wallet without linked history and budget references.
// If it is referenced by transactions, preserve it in the archive instead.
async function deleteWalletSafely(id){
 const w=state.wallets.find(x=>x.id===id);if(!w)return;
 const linkedTransactions=state.transactions.filter(t=>t.walletId===id||t.toWalletId===id);
 const linkedBudgets=state.budgets.filter(b=>b.walletId===id);
 const links=linkedTransactions.length+linkedBudgets.length;
 const active=state.wallets.filter(x=>x.status!=='closed');
 if(w.status!=='closed'&&active.length<=1){toast('Нельзя убрать единственный активный счёт. Сначала создай другой.');return;}
 if(links){
  if(w.status==='closed'){toast('Счёт содержит историю. Для безопасности его можно хранить только в архиве.');return;}
  const message=`У счёта «${w.name}» есть ${linkedTransactions.length} операций и ${linkedBudgets.length} связанных бюджетов.\n\nПереместить в архив? Старые операции и статистика останутся, но счёт исчезнет из активного списка и текущего баланса.`;
  if(!confirm(message))return;
  await save('wallets',{...w,status:'closed',archivedAt:new Date().toISOString()});
  await loadData();state.walletId=null;closeModal();render();toast('Счёт перемещён в архив. История сохранена.');return;
 }
 if(!confirm(`Удалить счёт «${w.name}» без возможности отмены? История не связана с этим счётом.`))return;
 await remove('wallets',id);await loadData();state.walletId=null;closeModal();render();toast('Лишний счёт удалён.');
}
async function restoreWallet(id){
 const w=state.wallets.find(x=>x.id===id&&x.status==='closed');if(!w)return;
 await save('wallets',{...w,status:'open',archivedAt:null});
 await loadData();state.walletId=id;closeModal();render();toast('Счёт восстановлен.');
}
// Вклад является счётом. Перенос тела вклада — перевод, не доход.
function openDeposit(){
 openModal('Новый вклад',`<form id="deposit-form" class="form-grid">
 ${field('Банк',`<input name="bank" maxlength="80" placeholder="Например, Т-Банк" required>`,true)}
 ${field('Название вклада',`<input name="name" maxlength="100" placeholder="Накопительный, Вклад на 6 месяцев" required>`,true)}
 ${field('Чей вклад',`<select name="owner">${ownerOptions(state.profileId==='family'?state.deviceOwner:state.profileId,true)}</select>`)}
 ${field('Валюта',`<select name="currency">${['RUB','EUR','USD'].map(c=>opt(c,c,c==='RUB')).join('')}</select>`)}
 ${field('Дата открытия',`<input name="openedAt" type="date" value="${today()}" required>`)}
 ${field('Дата окончания',`<input name="maturityDate" type="date">`)}
 ${field('Ставка годовых, %',`<input name="rate" type="number" min="0" max="100" step="0.01" value="0" required>`)}
 ${field('Уже лежит на вкладе',`<input name="principal" type="number" min="0" step="0.01" inputmode="decimal" value="0" required>`)}
 <div class="hint wide">Если вклад уже существует, укажи текущий остаток. Если только переводишь деньги с карты, оставь 0 и сделай перевод со счёта на вклад — это не доход и не расход.</div>
 <div class="modal-actions wide"><button type="button" class="btn" data-action="close-modal">Отмена</button><button type="submit" class="btn primary">Сохранить вклад</button></div></form>`);
}
async function submitDeposit(form){
 const f=new FormData(form),name=cleanName(f.get('name')),bank=cleanName(f.get('bank'));
 const principalMinor=Math.round(Number(f.get('principal'))*100),rate=Number(f.get('rate'));
 const openedAt=parseDate(f.get('openedAt')),
       maturityDate=f.get('maturityDate')?parseDate(f.get('maturityDate')):null;
 if(!bank||!name||!openedAt||(f.get('maturityDate')&&!maturityDate)||
    !Number.isSafeInteger(principalMinor)||principalMinor<0||!Number.isFinite(rate)||rate<0||rate>100)return toast('Проверьте реквизиты вклада.');
 if(maturityDate&&maturityDate<openedAt)return toast('Дата окончания раньше открытия.');
 if(principalMinor>0&&!confirm('Этот остаток уже находится на вкладе. Убедись, что та же сумма не осталась в другом счёте, иначе общие накопления задвоятся. Сохранить?'))return;
 const item={id:uid(),name,bank,ownerId:f.get('owner'),kind:'deposit',rate,openedAt,maturityDate,initialBalanceMinor:principalMinor,currency:f.get('currency'),status:'open'};
 await save('wallets',item);await loadData();state.walletId=item.id;closeModal();render();toast('Вклад добавлен. Проценты можно записать отдельным доходом.');
}
function openDepositInterest(){
 const deposits=state.wallets.filter(w=>w.kind==='deposit'&&w.status!=='closed'&&(state.profileId==='family'||ownerOfWallet(w)===state.profileId));
 if(!deposits.length)return toast('Сначала добавьте вклад во вкладке «Счета».');
 openModal('Начисление процентов',`<form id="deposit-interest-form" class="form-grid">
 ${field('Вклад',`<select name="deposit">${deposits.map(w=>opt(w.id,`${w.bank} · ${w.name}`,false)).join('')}</select>`,true)}
 ${field('Куда зачислены проценты',`<select name="creditWallet">${walletOptions(deposits[0].id,w=>w.currency===deposits[0].currency)}</select>`,true)}
 ${field('Дата начисления',`<input type="date" name="date" value="${today()}" required>`)}
 ${field('Сумма процентов',`<input type="number" name="amount" inputmode="decimal" min="0.01" step="0.01" required placeholder="0.00">`)}
 <p class="tiny muted wide">Запишется именно доход от процентов. Основная сумма вклада в доход не входит. Если проценты уже импортированы из банка как обычный доход, повторно добавлять их не нужно.</p>
 <div class="modal-actions wide"><button type="button" class="btn" data-action="close-modal">Отмена</button><button type="submit" class="btn primary">Добавить доход</button></div></form>`);
}
async function submitDepositInterest(form){
 const f=new FormData(form),dep=state.wallets.find(w=>w.id===f.get('deposit')&&w.kind==='deposit');
 const date=parseDate(f.get('date')),amountMinor=Math.round(Number(f.get('amount'))*100);
 if(!dep||!date||!Number.isSafeInteger(amountMinor)||amountMinor<=0)return toast('Укажите вклад, дату и проценты.');
 const credit=state.wallets.find(w=>w.id===f.get('creditWallet')&&w.currency===dep.currency);
 if(!credit)return toast('Счёт зачисления должен быть в валюте вклада.');
 const dupe=state.transactions.some(t=>t.type==='income'&&t.walletId===credit.id&&t.date===date&&t.amountMinor===amountMinor&&t.depositId===dep.id);
 if(dupe&&!confirm('Похожее начисление процентов уже записано. Добавить ещё раз?'))return;
 let category=state.categories.find(c=>c.type==='income'&&c.name==='Проценты по вкладам');
 if(!category){category={id:uid(),type:'income',name:'Проценты по вкладам',color:'#62c7a1'};await save('categories',category);}
 await save('transactions',{id:uid(),type:'income',amountMinor,walletId:credit.id,depositId:dep.id,ownerId:ownerOfWallet(dep),categoryId:category.id,
  toWalletId:null,note:`Проценты · ${dep.bank} · ${dep.name}`,labels:['вклад','проценты'],date,createdAt:new Date().toISOString()});
 await loadData();closeModal();render();toast('Проценты добавлены в доходы.');
}
function downloadDepositTemplate(){
 const rows=[['Банк','Название','Владелец','Дата открытия','Сумма','Ставка %','Дата окончания','Статус'],
  ['Пример банка','Вклад 6 месяцев','Я','01.01.2026','100000','14','01.07.2026','Открыт']];
 download('\uFEFF'+rows.map(r=>r.map(csvEscape).join(';')).join('\r\n'),'vklady-shablon.csv','text/csv;charset=utf-8');
}
async function importDepositsCSV(file){
 if(file.size>2*1024*1024)throw new Error('Файл слишком большой.');
 const rows=await readCSVFile(file),head=(rows[0]||[]).map(x=>x.trim().toLowerCase().replace(/ё/g,'е'));
 const col=(...names)=>head.findIndex(x=>names.includes(x));
 const ix={bank:col('банк','bank'),name:col('название','вклад','name'),owner:col('владелец','owner'),open:col('дата открытия','opened','open_date'),
  amount:col('сумма','остаток','amount'),rate:col('ставка %','ставка','rate'),maturity:col('дата окончания','maturity','end_date'),status:col('статус','status')};
 if(ix.bank<0||ix.name<0||ix.amount<0||ix.open<0)throw new Error('Нужны столбцы: Банк, Название, Дата открытия, Сумма. Скачайте шаблон.');
 const toAdd=[];let bad=0,duplicates=0;
 for(const r of rows.slice(1,501)){
  const get=k=>ix[k]>=0?String(r[ix[k]]||'').trim():'';
  const bank=cleanName(get('bank')),name=cleanName(get('name')),date=parseDate(get('open')),
    value=parseAmount(get('amount')),rate=Number(get('rate').replace(',','.')||0);
  if(!bank||!name||!date||value===null||value<0||!Number.isFinite(rate)||rate<0||rate>100){bad++;continue;}
  const owner=/жен|wife/i.test(get('owner'))?'wife':'me';
  const found=[...state.wallets,...toAdd].some(w=>w.kind==='deposit'&&w.bank.toLowerCase()===bank.toLowerCase()&&w.name.toLowerCase()===name.toLowerCase()&&w.openedAt===date&&ownerOfWallet(w)===owner);
  if(found){duplicates++;continue;}
  const maturityDate=parseDate(get('maturity'))||null;
  toAdd.push({id:uid(),kind:'deposit',name,bank,ownerId:owner,openedAt:date,maturityDate,rate,initialBalanceMinor:value,currency:'RUB',status:/закрыт|closed/i.test(get('status'))?'closed':'open'});
 }
 if(!toAdd.length){toast(`Новых вкладов нет. Ошибок ${bad}, повторов ${duplicates}.`);return;}
 if(!confirm(`Импортировать ${toAdd.length} вкладов? Ошибочных строк: ${bad}; повторов: ${duplicates}.\n\nСуммы будут записаны как остатки вкладов, а НЕ как доходы. Проверь, что остатки других счетов не задвоятся.`))return;
 await insertMany('wallets',toAdd);await loadData();render();toast(`Добавлено вкладов: ${toAdd.length}.`);
}
function openCategory(id){
 const c=state.categories.find(x=>x.id===id),selectedIcon=CATEGORY_ICONS.has(c?.icon)?c.icon:iconForCategory(c||{name:'',type:state.catUI.type});
 openModal(c?'Редактировать категорию':'Новая категория',`<form id="category-form" data-id="${esc(id||'')}" class="form-grid cat-editor">
 ${field('Название',`<input name="name" value="${esc(c?.name||'')}" required maxlength="160" placeholder="Например, Продукты">`,true)}
 ${field('Тип',`<select name="type" ${c?'disabled':''}>${opt('income','Доход',c?.type==='income'||(!c&&state.catUI.type==='income'))}${opt('expense','Расход',c?.type==='expense'||(!c&&state.catUI.type==='expense'))}</select>`)}
 ${field('Цвет категории',`<input type="color" name="color" value="${safeCategoryColor(c)}">`)}
 <div class="cat-icon-select wide"><div class="cat-icon-select-head"><span>Иконка категории</span><span class="cat-editor-preview" id="cat-editor-preview">${esc(selectedIcon)}</span></div>
 <input type="hidden" name="icon" value="${esc(selectedIcon)}">
 ${Object.entries(CATEGORY_ICON_GROUPS).map(([name,icons])=>`<div class="cat-icon-group"><b>${esc(name)}</b><div class="cat-icon-grid">${icons.map(icon=>`<button type="button" class="cat-icon-pick ${icon===selectedIcon?'chosen':''}" data-action="choose-category-icon" data-icon="${esc(icon)}" aria-label="Иконка ${esc(icon)}" aria-pressed="${icon===selectedIcon}">${esc(icon)}</button>`).join('')}</div></div>`).join('')}</div>
 <p class="cat-editor-note wide">Смена названия, цвета или иконки не меняет суммы старых операций.</p>
 <div class="modal-actions wide"><button type="button" class="btn" data-action="close-modal">Отмена</button><button class="btn primary" type="submit">Сохранить</button></div></form>`);
}
async function submitTransaction(form){
 const data=new FormData(form),existing=state.transactions.find(t=>t.id===form.dataset.id);
 const amount=Math.round(Number(String(data.get('amount')).replace(',','.'))*100),w=state.wallets.find(x=>x.id===data.get('wallet'));
 if(!w||!Number.isSafeInteger(amount)||amount<=0) return toast('Укажите корректную сумму и кошелёк.');
 const date=String(data.get('date'));
 if(!parseDate(date))return toast('Неверная дата.');
 const dest=state.wallets.find(x=>x.id===data.get('toWallet'));
 if(editingType==='transfer'&&(!dest||dest.id===w.id||dest.currency!==w.currency))return toast('Для перевода выберите другой кошелёк в той же валюте.');
 const cashback=editingType==='expense'?cashbackFormData(form,amount,existing):{cashbackMinor:0,cashbackStatus:'expected',cashbackDate:null};
 if(!cashback)return toast('Кешбэк должен быть от 0 до 100% стоимости покупки.');
 const item={...existing,...cashback,id:existing?.id||uid(),walletId:w.id,toWalletId:editingType==='transfer'?dest.id:null,amountMinor:amount,toAmountMinor:editingType==='transfer'?amount:null,type:editingType,ownerId:String(data.get('owner')||state.deviceOwner),date,categoryId:editingType==='transfer'?null:String(data.get('category')||'')||null,note:cleanName(data.get('note')),labels:String(data.get('labels')||'').split(',').map(cleanName).filter(Boolean),createdAt:existing?.createdAt||new Date().toISOString(),projectId:editingType==='expense'&&data.get('houseProject')==='on'?'home':null,houseSection:editingType==='expense'&&data.get('houseProject')==='on'?String(data.get('houseSection')||'other'):null,houseSubprojectId:editingType==='expense'&&data.get('houseProject')==='on'?String(data.get('houseSubproject')||'')||null:null};
 state.pendingHomeExpense=false;state.pendingRecurring=null;await save('transactions',item);await loadData();closeModal();render();toast('Операция сохранена.');
}
async function submitBudget(form){
 const f=new FormData(form),old=state.budgets.find(b=>b.id===form.dataset.id),limitMinor=Math.round(Number(f.get('limit'))*100);
 if(!Number.isSafeInteger(limitMinor)||limitMinor<=0)return toast('Укажите правильный лимит.');
 await save('budgets',{id:old?.id||uid(),ownerId:f.get('owner')||state.deviceOwner,name:cleanName(f.get('name')),limitMinor,walletId:f.get('wallet'),categoryId:f.get('category')||null});
 await loadData();closeModal();render();toast('Бюджет сохранён.');
}
async function submitWallet(form){
 const f=new FormData(form),old=state.wallets.find(w=>w.id===form.dataset.id),initialBalanceMinor=Math.round(Number(f.get('initial'))*100);
 if(!Number.isSafeInteger(initialBalanceMinor))return toast('Некорректный начальный баланс.');
 const w={...old,id:old?.id||uid(),ownerId:String(f.get('owner')||'me'),name:cleanName(f.get('name')),currency:old?.currency||f.get('currency'),initialBalanceMinor};
 if(old?.kind==='deposit'){
  const rate=Number(f.get('rate'));if(!Number.isFinite(rate)||rate<0||rate>100)return toast('Некорректная ставка вклада.');
  w.rate=rate;w.bank=cleanName(f.get('bank'));w.maturityDate=parseDate(f.get('maturityDate'))||null;w.status=f.get('status')==='closed'?'closed':'open';
 }
 await save('wallets',w);await loadData();state.walletId=w.id;closeModal();render();toast('Кошелёк сохранён.');
}
async function submitCategory(form){
 const f=new FormData(form),old=state.categories.find(c=>c.id===form.dataset.id);
 const icon=String(f.get('icon')||'');
 const c={...old,id:old?.id||uid(),name:cleanName(f.get('name')),type:old?.type||f.get('type'),color:String(f.get('color')||'#c59e79'),icon:CATEGORY_ICONS.has(icon)?icon:'🧾',hiddenProfiles:Array.isArray(old?.hiddenProfiles)?old.hiddenProfiles:[]};
 if(!c.name)return toast('Укажите название категории.');
 if(state.categories.some(x=>x.id!==c.id&&x.type===c.type&&x.name.toLocaleLowerCase('ru')===c.name.toLocaleLowerCase('ru'))) return toast('Такая категория уже существует.');
 await save('categories',c);await loadData();closeModal();render();toast('Категория сохранена.');
}
function download(content,filename,mime){
 const blob=new Blob([content],{type:mime});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),3000);
}
function backupJSON(){
 const data={version:1,exportedAt:new Date().toISOString(),familyMode:1,wallets:state.wallets,categories:state.categories,transactions:state.transactions,budgets:state.budgets};
 download(JSON.stringify(data,null,2),`moy-koshelek-backup-${today()}.json`,'application/json;charset=utf-8');
}
function exportCSV(){
 const rows=[['Date','Type','Amount','Currency','Wallet','Owner','To wallet','Category','Note','Labels','Cashback','Cashback status','Cashback date','Net expense']];
 for(const t of [...state.transactions].sort(sortTx)){
   const w=state.wallets.find(x=>x.id===t.walletId);
   rows.push([t.date,t.type,((t.type==='expense'?-1:1)*t.amountMinor/100).toFixed(2),w?.currency||'RUB',w?.name||'',OWNERS[ownerOfTx(t)],t.toWalletId?walletName(t.toWalletId):'',cat(t.categoryId)?.name||'',t.note,(t.labels||[]).join(', '),(benefit(t)/100).toFixed(2),t.cashbackStatus||'',t.cashbackDate||'',(t.type==='expense'?netExpense(t)/100:0).toFixed(2)]);
 }
 download('\uFEFF'+rows.map(r=>r.map(csvEscape).join(';')).join('\r\n'),`moy-koshelek-${today()}.csv`,'text/csv;charset=utf-8');
}
async function restoreJSONData(data){
 const counts=validateBackup(data);
 if(cloud.status().active){
  if(!confirm(`В файле ${counts.transactions.toLocaleString('ru-RU')} операций.\n\nДобавить отсутствующие записи в семейный бюджет, не удаляя уже существующие?\n\nПеред импортом рекомендуется сохранить JSON-копию.`))return;
  const notice=$('#toast');if(notice){notice.textContent='Подготовка импорта… Не закрывай приложение.';notice.classList.add('visible');clearTimeout(toast.timer);}
  const result=await cloud.mergeImportedBackup(data,(done,total)=>{const t=$('#toast');if(t){t.classList.add('visible');t.textContent=`Отправлено ${done.toLocaleString('ru-RU')} из ${total.toLocaleString('ru-RU')} записей. Не закрывай приложение.`;}});
  await loadData();render();
  if(result.error)alert(`Добавлено на устройство ${result.added} записей, но отправка завершилась с ошибкой: ${result.error}.\n\nДанные сохранены на этом устройстве и ожидают синхронизации. НЕ повторяй импорт и не удаляй данные приложения.`);
  else toast(`Импорт: добавлено ${result.added} записей, пропущено существующих ${result.skipped+result.duplicates}.`);
  return;
 }
 if(!confirm(`В файле найдено ${counts.transactions.toLocaleString('ru-RU')} операций и ${counts.categories} категорий.\n\nПОЛНОСТЬЮ ЗАМЕНИТЬ текущую базу на данные из файла?\n\nЕсли есть новые операции, сначала скачай резервную копию.`))return;
 await replaceDatabase(data);
 await loadData();render();
 toast(`База восстановлена: ${counts.transactions.toLocaleString('ru-RU')} операций.`);
}
async function importCategoryList(imported){
 const current=new Set(state.categories.map(c=>c.type+'|'+c.name.toLocaleLowerCase('ru')));
 const usedIds=new Set(state.categories.map(c=>c.id));
 const unique=[];
 for(const c of imported){
  const key=c.type+'|'+c.name.toLocaleLowerCase('ru');
  if(current.has(key))continue;
  current.add(key);
  const id=(typeof c.id==='string'&&c.id&&!usedIds.has(c.id))?c.id:uid();
  usedIds.add(id);
  unique.push({id,name:cleanName(c.name),type:c.type,color:/^#[0-9a-fA-F]{6}$/.test(c.color)?c.color:'#39a888'});
 }
 await insertMany('categories',unique);
 const upload=await cloud.importAddedRecords({categories:unique});
 await loadData();render();toast(`Категорий добавлено: ${unique.length}.${upload.error?' Отправка будет повторена.':''}`);
}
async function importDataFile(file){
 if(/\.csv$/i.test(file.name)){
  state.importRows=await readCSVFile(file);
  state.importHeaders=state.importRows[0]||[];
  state.importMapping=guessMapping(state.importHeaders);
  openImportWizard();
  return;
 }
 let parsed;
 try{parsed=JSON.parse((await file.text()).replace(/^\uFEFF/,''));}
 catch{throw new Error('Файл не является корректным JSON. Для CSV выберите файл с расширением .csv.');}
 const kind=detectJSONKind(parsed);
 if(kind==='backup')return restoreJSONData(parsed);
 return importCategoryList(parsed);
}
function openImportWizard(){
 if(!state.importRows||state.importRows.length<2)return toast('CSV пуст или не содержит операций.');
 const headers=state.importHeaders, mapping=state.importMapping;
 const fields=[['date','Дата *'],['amount','Сумма *'],['category','Категория'],['note','Заметка'],['wallet','Кошелёк'],['type','Тип операции'],['labels','Метки']];
 const selects=fields.map(([key,label])=>field(label,`<select name="${key}">${opt('-1','Не импортировать',mapping[key]===-1)}${headers.map((h,i)=>opt(i,`${h||'(без названия)'} (${i+1})`,i===mapping[key])).join('')}</select>`)).join('');
 const preview=`<div class="preview"><table><thead><tr>${headers.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${state.importRows.slice(1,6).map(r=>`<tr>${headers.map((_,i)=>`<td>${esc((r[i]||'').slice(0,100))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
 openModal('Импорт операций из CSV',`<p class="muted tiny">Строк в файле: ${state.importRows.length-1}. Укажите соответствие столбцов. Проверьте, что расходы имеют отрицательную сумму или отдельный столбец типа.</p>
  <form id="import-form"><div class="import-grid">${selects}</div><hr class="soft-divider"/><div class="hint">Даты формата ДД.ММ.ГГГГ и ГГГГ-ММ-ДД. При отсутствии столбца кошелька все операции попадут в выбранный кошелёк «${esc(wallet().name)}». Переводы из CSV автоматически не связываются и будут пропущены.</div>${preview}
  <div class="modal-actions"><button class="btn" type="button" data-action="close-modal">Отмена</button><button class="btn primary" type="submit">Импортировать</button></div></form>`);
}
async function doCSVImport(form){
 const m=Object.fromEntries(new FormData(form).entries());for(const k in m)m[k]=Number(m[k]);
 if(m.date<0||m.amount<0)return toast('Укажите столбцы даты и суммы.');
 const rows=state.importRows.slice(1), wallets=[...state.wallets],categories=[...state.categories];
 const newWallets=[],newCategories=[],newTx=[],errors=[], seen=new Set(state.transactions.map(t=>t.sourceKey).filter(Boolean));
 const duplicates=new Map(), fallbackWallet=wallet(); let skipped=0,transfers=0;
 for(let i=0;i<rows.length;i++){
  const r=rows[i];const read=k=>m[k]>=0?String(r[m[k]]||'').trim():'';
  const date=parseDate(read('date')),signed=parseAmount(read('amount'));
  if(!date||signed==null){skipped++;if(errors.length<4)errors.push(`строка ${i+2}: дата или сумма`);continue;}
  const type=parseType(read('type'),signed);if(type==='transfer'){transfers++;continue;}
  const amountMinor=Math.abs(signed);if(amountMinor===0){skipped++;continue;}
  const walletLabel=cleanName(read('wallet'))||fallbackWallet.name;
  let w=wallets.find(w=>w.name.toLocaleLowerCase('ru')===walletLabel.toLocaleLowerCase('ru'));
  if(!w){w={id:uid(),name:walletLabel,ownerId:state.profileId==='family'?state.deviceOwner:state.profileId,currency:fallbackWallet.currency,initialBalanceMinor:0};newWallets.push(w);wallets.push(w);}
  const name=cleanName(read('category'))||'Без категории';
  let c=categories.find(c=>c.type===type&&c.name.toLocaleLowerCase('ru')===name.toLocaleLowerCase('ru'));
  if(!c){c={id:uid(),name,type,color:type==='income'?'#38b88d':'#e36e7b'};newCategories.push(c);categories.push(c);}
  const note=read('note'),labels=read('labels').split(/[,;#]/).map(cleanName).filter(Boolean);
  const keyBase=[date,type,amountMinor,w.name.toLowerCase(),name.toLowerCase(),note,labels.join(',')].join('|');
  const nth=(duplicates.get(keyBase)||0)+1;duplicates.set(keyBase,nth);
  const sourceKey='csv:'+fingerprint(keyBase)+':'+nth;
  if(seen.has(sourceKey))continue;
  seen.add(sourceKey);
  newTx.push({id:uid(),date,type,ownerId:state.profileId==='family'?state.deviceOwner:state.profileId,amountMinor,walletId:w.id,toWalletId:null,categoryId:c.id,note,labels,sourceKey,createdAt:new Date().toISOString()});
 }
 try{
  await insertMany('wallets',newWallets);await insertMany('categories',newCategories);await insertMany('transactions',newTx);
  let syncProblem='';
  if(cloud.status().active){try{await cloud.sync();}catch(e){syncProblem=e.message;}}
  await loadData();closeModal();render();
  state.importRows=null;state.importHeaders=null;state.importMapping=null;
  toast(`Добавлено ${newTx.length}, пропущено ошибок ${skipped}, переводов ${transfers}.${syncProblem?' Отправка ещё не завершена.':''}`);
  if(syncProblem)alert('Импорт сохранён локально. Ошибка облачной отправки: '+syncProblem+'\nПовтори синхронизацию позже, НЕ импортируй файл повторно.');
  if(errors.length)alert('Примеры некорректных строк:\n'+errors.join('\n'));
 }catch(e){toast('Ошибка импорта: '+e.message);}
}

function bind(){
 document.addEventListener('click',async e=>{
  const nav=e.target.closest('[data-page]');if(nav){setPage(nav.dataset.page);return;}
  if(e.target.closest('#floating-add')){state.pendingRecurring=null;state.pendingHomeExpense=false;openQuickAdd('income');return;}
  const el=e.target.closest('[data-action]');if(!el)return;
  const a=el.dataset.action,id=el.dataset.id;
  if(a==='backdrop'&&e.target!==el)return;
  try{
   if(a==='backdrop'||a==='close-modal'){closeModal();return;}
   if(a==='cloud-logout'){if(!confirm('Выйти из облака? Сохранённая история останется на телефоне.'))return;cloud.signOut();render();return;}
   if(a==='cloud-list-families'){
     const families=await cloud.families();if(!families.length){toast('Семей пока нет. Создай одну или введи код приглашения.');return;}
     openModal('Выбери семейный бюджет',`<div class="cloud-families">${families.map(f=>`<button class="btn" data-action="cloud-select-family" data-id="${esc(f.family_id)}">Семья ${esc(f.family_id.slice(0,8))} · ${esc(f.role)}</button>`).join('')}</div>`);return;
   }
   if(a==='cloud-select-family'){await cloud.chooseFamily(id);closeModal();render();return;}
   if(a==='cloud-invite'){
     if(!confirm('Создать НОВЫЙ код? Предыдущий код перестанет действовать.'))return;
     const code=await cloud.rotateInvite();openModal('Код для жены',`<p>Передай этот код лично жене. Он даёт доступ к семейным финансам.</p><textarea class="cloud-invite-text" readonly>${esc(code)}</textarea><button class="btn" data-action="cloud-copy-invite" data-code="${esc(code)}">Копировать</button>`);return;
   }
   if(a==='cloud-copy-invite'){await navigator.clipboard.writeText(el.dataset.code);toast('Код скопирован.');return;}
   if(a==='cloud-start'){
     if(cloud.status().busy){toast('Обновление уже выполняется');return;}
     const hasRemote=await cloud.cloudHasRecords();
     if(hasRemote){
       if(!confirm('Загрузить семейные данные на это устройство? Текущие местные записи будут заменены. Сначала сохрани JSON-копию в разделе «Резервная копия».'))return;
       const r=await cloud.initialDownload();await loadData();render();toast(`Данные загружены: ${r.transactions||0} операций`);return;
     }
     if(!confirm('Начать синхронизацию и отправить записи с этого устройства в семейный бюджет? Перед этим сохрани JSON-копию.'))return;
     const r=await cloud.initialUpload((done,total)=>{const t=$('#toast');if(t)t.textContent=`Отправлено ${done} из ${total}`});
     render();toast(`Синхронизация включена. Отправлено ${r.sent} записей.`);return;
   }
   if(a==='cloud-sync'){const r=await cloud.sync();await loadData();render();toast(`Синхронизация завершена: ${r?.sent||0} изменений отправлено.`);return;}

   if(a==='adjust-balances'){openBalanceAdjustment();return;}
   if(a==='home-settings'){openHomeSettings();return;}
   if(a==='add-home-expense'){state.pendingRecurring=null;state.pendingHomeExpense=true;openQuickAdd('expense');return;}
   if(a==='add-recurring'){openRecurring();return;}
   if(a==='pay-recurring'){const b=state.budgets.find(x=>x.id===id);if(b){state.pendingHomeExpense=false;state.pendingRecurring=b;openQuickAdd('expense');toast(`Плановый платёж: ${b.name}`)}return;}
   if(a==='show-budgets'){setPage('budgets');return;}
   if(a==='show-transactions'){setPage('transactions');return;}
   if(a==='go-accounts'){setPage('accounts');return;}
   if(a==='select-profile'){
    if(!PROFILE_LOOK[id])return;state.profileId=id;saveLocal(FAMILY_KEY,id);state.walletId=null;render();return;
   }
   if(a==='switch-device-profile'){
    state.profileId=state.deviceOwner;state.walletId=null;saveLocal(FAMILY_KEY,state.profileId);render();return;
   }
   if(a==='quick-type'){quickType=el.dataset.type;refreshQuickCategoryPicker();return;}
   if(a==='choose-quick-category'){const chosen=state.categories.find(c=>c.id===id&&c.type===quickType);if(chosen&&!isCategoryHidden(chosen)){closeModal();openTransaction(null,quickType,id);}return;}
   if(a==='quick-no-category'){closeModal();openTransaction(null,quickType);return;}
   if(a==='quick-income'||a==='quick-expense'){closeModal();openTransaction(null,a==='quick-income'?'income':'expense');return;}
   if(a==='add-deposit'){openDeposit();return;}
   if(a==='add-interest'){openDepositInterest();return;}
   if(a==='download-deposit-template'){downloadDepositTemplate();return;}
   if(a==='prev-month'){state.focusMonth=moveMonth(state.focusMonth,-1);state.period='month';render();return;}
   if(a==='next-month'){if(state.focusMonth<today().slice(0,7))state.focusMonth=moveMonth(state.focusMonth,1);state.period='month';render();return;}
   if(a==='current-month'){state.focusMonth=today().slice(0,7);state.period='month';render();return;}
   if(a==='select-month'){if(el.dataset.month){state.focusMonth=el.dataset.month;state.period='month';render();}return;}
   if(a==='add-tx'){state.pendingRecurring=null;state.pendingHomeExpense=false;openQuickAdd('income');return;}
   if(a==='scan-expense'){closeModal();openScreenshotExpense();return;}
   if(a==='edit-tx'){openTransaction(id);return;}
   if(a==='delete-tx'){
    if(confirm('Удалить эту операцию без возможности отмены?')){await remove('transactions',id);await loadData();closeModal();render();toast('Операция удалена.');}return;
   }
   if(a==='type-tab'){editingType=el.dataset.type;updateTransactionType();const selected=$('#tx-form [name=category]')?.selectedOptions?.[0]?.textContent;const heading=$('.tx-entry-category');if(heading)heading.textContent=selected&&selected!=='Без категории'?selected:'Без категории';return;}
   if(a==='keypad-key'){useKeypadKey(el.dataset.key);return;}
   if(a==='more-tx'){state.maxTx+=100;$('#tx-list').innerHTML=transactionList();return;}
   if(a==='clear-filters'){state.txFilters={search:'',category:'all',kind:'all',from:'',to:'',min:'',max:''};state.maxTx=100;render();return;}
   if(a==='add-budget'){openBudget();return;}
   if(a==='edit-budget'){openBudget(id);return;}
   if(a==='delete-budget') {if(confirm('Удалить бюджет?')){await remove('budgets',id);await loadData();render();}return;}
   if(a==='house-new-section'){openHouseEditor('sections');return;}
   if(a==='house-new-subproject'){openHouseEditor('subprojects');return;}
   if(a==='house-manage-sections'){openHouseManager('sections');return;}
   if(a==='house-manage-subprojects'){openHouseManager('subprojects');return;}
   if(a==='house-edit-section'){openHouseEditor('sections',id);return;}
   if(a==='house-edit-subproject'){openHouseEditor('subprojects',id);return;}
   if(a==='house-filter-section'){state.houseUI.section=state.houseUI.section===id?'all':id;state.houseUI.subproject='all';render();return;}
   if(a==='house-filter-subproject'){state.houseUI.subproject=state.houseUI.subproject===id?'all':id;render();return;}
   if(a==='choose-house-subproject'){
     const form=el.closest('#tx-form');if(!form)return;const selected=houseTaxonomy().subprojects.find(x=>x.id===id);
     form.elements.houseSubproject.value=selected?.id||'';
     if(selected)form.elements.houseSection.value=selected.sectionId;
     houseSubprojectChoices(form.querySelector('#house-subproject-search')?.value||'',form);
     return;
   }
   if(a==='add-wallet'){openWallet();return;}
   if(a==='edit-wallet'){openWallet(id);return;}
   if(a==='delete-wallet'){await deleteWalletSafely(id);return;}
   if(a==='restore-wallet'){await restoreWallet(id);return;}
   if(a==='choose-wallet'){state.walletId=id;render();return;}
   if(a==='open-categories'){setPage('categories');return;}
   if(a==='back-to-settings'){setPage('settings');return;}
   if(a==='category-type'){state.catUI.type=el.dataset.type;state.catUI.view='active';render();return;}
   if(a==='category-view'){state.catUI.view=el.dataset.view;render();return;}
   if(a==='toggle-category'){
     const old=state.categories.find(c=>c.id===id);if(!old)return;
     const hidden=new Set(old.hiddenProfiles||[]),wasHidden=hidden.has(state.profileId);
     if(wasHidden)hidden.delete(state.profileId);else hidden.add(state.profileId);
     await save('categories',{...old,hiddenProfiles:[...hidden]});await loadData();render();toast(wasHidden?'Категория снова активна.':'Категория скрыта из выбора.');return;
   }
   if(a==='choose-category-icon'){
     const form=el.closest('#category-form'),icon=el.dataset.icon;
     if(!form||!CATEGORY_ICONS.has(icon))return;
     form.elements.icon.value=icon;form.querySelector('#cat-editor-preview').textContent=icon;
     form.querySelectorAll('.cat-icon-pick').forEach(b=>{const yes=b.dataset.icon===icon;b.classList.toggle('chosen',yes);b.setAttribute('aria-pressed',String(yes));});return;
   }
   if(a==='add-category'){openCategory();return;}
   if(a==='edit-category'){openCategory(id);return;}
   if(a==='backup-json'){backupJSON();return;}
   if(a==='export-csv'){exportCSV();return;}
  }catch(err){console.error(err);toast('Ошибка: '+err.message);}
 });
 document.addEventListener('submit',async e=>{
  const f=e.target;if(!['tx-form','budget-form','wallet-form','category-form','import-form','ocr-expense-form','deposit-form','deposit-interest-form','cloud-auth-form','cloud-create-form','cloud-join-form','balances-form','home-settings-form','recurring-form','house-section-form','house-subproject-form'].includes(f.id))return;
  e.preventDefault();const btn=f.querySelector('button[type=submit]');if(btn)btn.disabled=true;
  try{
    if(f.id==='cloud-auth-form'){
      const d=new FormData(f),register=e.submitter?.value==='register';
      if(register){const live=await cloud.signUp(String(d.get('email')),String(d.get('password')));toast(live?'Регистрация выполнена.':'Проверь почту: подтверди регистрацию и затем войди.');}
      else {const ff=await cloud.signIn(String(d.get('email')),String(d.get('password')));toast(ff.length?'Вход выполнен.':'Вход выполнен. Создай семью.');}
      render();return;
    }
    if(f.id==='cloud-create-form'){const code=await cloud.createFamily(String(new FormData(f).get('familyName')));openModal('Семья создана',`<p>Сохрани код для присоединения жены. Его можно показать только сейчас, но позже создать новый.</p><textarea class="cloud-invite-text" readonly>${esc(code)}</textarea><button class="btn" data-action="cloud-copy-invite" data-code="${esc(code)}">Скопировать код</button>`);render();return;}
    if(f.id==='cloud-join-form'){await cloud.joinFamily(String(new FormData(f).get('invite')));render();toast('Ты присоединился к семье. Теперь скачай её историю.');return;}
    if(f.id==='house-section-form')await submitHouseEditor(f,'sections');if(f.id==='house-subproject-form')await submitHouseEditor(f,'subprojects');if(f.id==='balances-form')await saveBalanceAdjustment(f);if(f.id==='home-settings-form')await saveHomeSettings(f);if(f.id==='recurring-form')await saveRecurring(f);if(f.id==='tx-form')await submitTransaction(f);if(f.id==='ocr-expense-form')await submitOcrExpense(f);if(f.id==='budget-form')await submitBudget(f);if(f.id==='wallet-form')await submitWallet(f);if(f.id==='category-form')await submitCategory(f);if(f.id==='import-form')await doCSVImport(f);if(f.id==='deposit-form')await submitDeposit(f);if(f.id==='deposit-interest-form')await submitDepositInterest(f);}
  catch(err){console.error(err);toast('Ошибка: '+err.message);}
  finally{if(btn&&btn.isConnected)btn.disabled=false;}
 });
 document.addEventListener('change',async e=>{
  const el=e.target,id=el.id;
  if(el.name==='houseProject'&&el.closest('#tx-form')){
   const form=el.closest('#tx-form');form.querySelector('#house-tx-fields')?.classList.toggle('hidden',!el.checked);
   if(el.checked)houseSubprojectChoices('',form);return;
  }
  if(el.name==='houseSection'&&el.closest('#tx-form')){
   const form=el.closest('#tx-form'),selected=houseTaxonomy().subprojects.find(x=>x.id===form.elements.houseSubproject.value);
   if(selected&&selected.sectionId!==el.value)form.elements.houseSubproject.value='';
   houseSubprojectChoices(form.querySelector('#house-subproject-search')?.value||'',form);return;
  }
  if(id==='wallet-picker'){state.walletId=el.value;render();return;}
  if(id==='category-manager-sort'){state.catUI.sort=el.value;$('#categories-results').innerHTML=categoryManagerItems();return;}
  if(el.name==='deposit'&&el.closest('#deposit-interest-form')){const d=state.wallets.find(w=>w.id===el.value);const dest=el.closest('form').querySelector('[name=creditWallet]');if(d&&dest)dest.innerHTML=walletOptions(d.id,w=>w.currency===d.currency);return;}
  if(id==='device-owner'){
   state.deviceOwner=el.value==='wife'?'wife':'me';saveLocal(DEVICE_KEY,state.deviceOwner);
   state.profileId=state.deviceOwner;saveLocal(FAMILY_KEY,state.profileId);state.walletId=null;render();return;
  }
  if(id==='deposit-csv-file'&&el.files?.[0]){
   const file=el.files[0];el.value='';try{await importDepositsCSV(file);}catch(err){alert('Импорт вкладов: '+err.message);}return;
  }
  if(id==='ocr-image'&&el.files?.[0]){const file=el.files[0];el.value='';await scanExpenseImage(file);return;}
  if(id==='period-picker'){state.period=el.value;render();return;}
  if(['tx-kind','tx-category','tx-from','tx-to','tx-min','tx-max'].includes(id)){
   state.txFilters[{'tx-kind':'kind','tx-category':'category','tx-from':'from','tx-to':'to','tx-min':'min','tx-max':'max'}[id]]=el.value;
   state.maxTx=100;$('#tx-list').innerHTML=transactionList();return;
  }
  if(['data-import-file','csv-file','restore-file','categories-seed-file'].includes(id)&&el.files?.[0]){
   const file=el.files[0];el.value='';
   try{await importDataFile(file);}
   catch(err){console.error(err);alert('Не удалось импортировать файл: '+err.message);}
   return;
  }
  if(el.name==='wallet' && el.closest('#tx-form')){
   updateCashbackPreview(el.closest('#tx-form'),'init');
   const form=el.closest('form');const current=state.wallets.find(w=>w.id===el.value);
   const t=form.querySelector('[name=toWallet]');if(t)t.innerHTML='<option value="">Выберите</option>'+walletOptions('',w=>w.id!==current?.id&&w.currency===current?.currency);
  }
 });
 document.addEventListener('input',e=>{
  const cbForm=e.target.closest('#tx-form,#ocr-expense-form');
  if(cbForm && ['amount','cashbackPercent','cashbackAmount'].includes(e.target.name)){
   updateCashbackPreview(cbForm,e.target.name==='amount'?'gross':e.target.name==='cashbackPercent'?'percent':'cashbackAmount');
  }

  if(e.target.id==='tx-search'){state.txFilters.search=e.target.value;state.maxTx=100;$('#global-search').value=e.target.value;$('#tx-list').innerHTML=transactionList();}
  if(e.target.id==='global-search'){state.txFilters.search=e.target.value;state.maxTx=100;if(state.page!=='transactions')setPage('transactions');else $('#tx-list').innerHTML=transactionList();}
  if(e.target.id==='category-manager-search'){state.catUI.search=e.target.value;$('#categories-results').innerHTML=categoryManagerItems();}
  if(e.target.id==='house-subproject-search')houseSubprojectChoices(e.target.value,e.target.closest('#tx-form'));
  if(e.target.id==='house-project-search'){
   state.houseUI.search=e.target.value;
   const rows=state.transactions.filter(t=>t.projectId==='home'&&t.type==='expense').sort(sortTx);
   const list=$('#house-subproject-grid'),history=$('#house-operation-list');if(list)list.innerHTML=houseSubprojectList(rows);if(history)history.innerHTML=houseOperationRows(rows);
  }
  if(e.target.id==='quick-category-search'){$('#quick-category-grid').innerHTML=quickCategoryItems(e.target.value);}
 });
 document.addEventListener('keydown',e=>{if(e.key==='Escape')closeModal(); if(e.target.closest('#tx-form')&&!e.target.closest('.tx-extra')&&(e.key===','||e.key==='.'||/^[0-9]$/.test(e.key)||e.key==='Backspace')){e.preventDefault();useKeypadKey(e.key==='Backspace'?'back':e.key==='.'?',':e.key);return;} if((e.key==='Enter'||e.key===' ')&&e.target.matches('[data-action=select-month]')){e.preventDefault();e.target.click();}});
  $('#open-filters').addEventListener('click',()=>{setPage('transactions');document.getElementById('tx-search')?.focus();});
}
async function start(){
 try{cloud.init();await loadData();bind();cloud.onStatus(()=>{if(state.page==='settings')render();});window.addEventListener('cloud-changed',async()=>{await loadData();render();});render();if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js').catch(console.warn);}
 catch(e){console.error(e);$('#content').innerHTML=`<section class="panel">Ошибка открытия базы: ${esc(e.message)}. Проверьте, что сайт запущен по HTTPS или localhost и браузер разрешает IndexedDB.</section>`;}
}
start();
