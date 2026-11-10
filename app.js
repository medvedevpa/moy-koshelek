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
const OWNERS={me:'Мой',wife:'Жены',family:'Семья'};
let state = { wallets:[], categories:[], transactions:[], budgets:[], page:'dashboard', walletId:null, profileId:profilePref(), deviceOwner:devicePref(), period:'month', focusMonth:today().slice(0,7), txFilters:{search:'',category:'all',kind:'all',from:'',to:'',min:'',max:''}, maxTx:100, importRows:null, importHeaders:null, importMapping:null };

function wallet() {
 const picked=state.wallets.find(w=>w.id===state.walletId);
 if(picked&&(state.profileId==='family'||ownerOfWallet(picked)===state.profileId))return picked;
 return state.wallets.find(w=>state.profileId!=='family'&&ownerOfWallet(w)===state.profileId&&w.currency==='RUB')||state.wallets.find(w=>w.currency==='RUB')||state.wallets[0];
}
function ownerOfWallet(w){return w?.ownerId==='wife'?'wife':'me';}
function ownerOfTx(t){return t.ownerId==='wife'||t.ownerId==='me'?t.ownerId:ownerOfWallet(state.wallets.find(w=>w.id===t.walletId));}
function scopeMatches(t){return state.profileId==='family'||ownerOfTx(t)===state.profileId;}
function walletCurrencyMatches(t,w){return (state.wallets.find(x=>x.id===t.walletId)?.currency||'RUB')===w.currency;}
function visibleTx(t,w){return scopeMatches(t)&&walletCurrencyMatches(t,w);}
function displayDelta(t,w){
 if(t.type==='income')return t.amountMinor;
 if(t.type==='expense')return -netExpense(t);
 return 0; // Переводы не являются семейным доходом или расходом.
}
function ownerOptions(selected='me',family=false){return ['me','wife',...(family?['family']:[])].map(id=>opt(id,OWNERS[id],selected===id)).join('');}
function profileBar(){return `<div class="profile-bar" role="group" aria-label="Чей бюджет показывать">${['me','wife','family'].map(id=>`<button class="profile-option ${state.profileId===id?'current':''}" data-action="select-profile" data-id="${id}">${id==='me'?'🌙':id==='wife'?'🌸':'🏠'} ${OWNERS[id]}</button>`).join('')}</div>`;}
function applyTheme(){
 const theme=(state.profileId==='family'?state.deviceOwner:state.profileId)==='wife'?'rose':'night';
 document.documentElement.dataset.theme=theme;
 document.querySelector('meta[name="theme-color"]')?.setAttribute('content',theme==='rose'?'#fff6f9':'#141b27');
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
function balance(w, dateEnd=today()) {
 return (w.initialBalanceMinor||0)+state.transactions.reduce((sum,t)=>{
   if(t.type==='expense'&&t.walletId===w.id) return sum-(t.date<=dateEnd?t.amountMinor:0)+settledCashback(t,dateEnd);
   return sum+(t.date<=dateEnd?txDelta(t,w):0);
 },0);
}
function filteredByPeriod(w) { const start=datePeriod(); const end=state.period==='month'?state.focusMonth+'-31':today();return state.transactions.filter(t=>isWalletTx(t,w)&&(!start||t.date>=start)&&t.date<=end); }
function sumType(rows,type,w) { return rows.filter(t=>t.type===type && visibleTx(t,w)).reduce((s,t)=>s+(type==='expense'?netExpense(t):t.amountMinor),0); }
function sortTx(a,b){ return b.date.localeCompare(a.date) || String(b.createdAt||'').localeCompare(String(a.createdAt||'')); }
const opt=(value,label,selected)=>`<option value="${esc(value)}" ${selected?'selected':''}>${esc(label)}</option>`;
function categoryOptions(type, selected='', allowAll=false){
  const cats=state.categories.filter(c=>type==='all'||c.type===type).sort((a,b)=>a.name.localeCompare(b.name,'ru'));
  return (allowAll?opt('all','Все категории',selected==='all'):'')+cats.map(c=>opt(c.id,c.name,c.id===selected)).join('');
}
function walletOptions(selected='', filter=()=>true){return state.wallets.filter(filter).map(w=>opt(w.id,`${w.name} · ${w.currency}`,w.id===selected)).join('');}
async function loadData(){
  const [wallets,categories,transactions,budgets]=await Promise.all(['wallets','categories','transactions','budgets'].map(getAll));
  Object.assign(state,{wallets,categories,transactions,budgets});
  if(!wallets.length){
    const w={id:uid(),name:'Наличные',currency:'RUB',initialBalanceMinor:0};
    await save('wallets',w); state.wallets=[w];
  }
  if(!state.wallets.some(w=>ownerOfWallet(w)==='wife')){
    const spouse={id:uid(),name:'Карта жены',ownerId:'wife',currency:'RUB',initialBalanceMinor:0};
    await save('wallets',spouse);state.wallets.push(spouse);
  }
  if(!categories.length){
    const seed=[{id:uid(),name:'Другое',type:'income',color:'#50b9a1'},{id:uid(),name:'Другое',type:'expense',color:'#e66b80'}];
    await insertMany('categories',seed);state.categories=seed;
  }
  if (!state.wallets.some(w=>w.id===state.walletId)) state.walletId=state.wallets[0].id;
  // Legacy Spendee backup has no owner fields: all historic rows remain assigned to "Мой".
  if(!['me','wife','family'].includes(state.profileId))state.profileId='me';
  if(!['me','wife'].includes(state.deviceOwner))state.deviceOwner='me';
}
function toast(message){const t=$('#toast');t.textContent=message;t.classList.add('visible');clearTimeout(toast.timer);toast.timer=setTimeout(()=>t.classList.remove('visible'),3500);}
function render(){
  const titles={dashboard:'Главная',accounts:'Счета',overview:'Обзор',transactions:'История',budgets:'Бюджеты',settings:'Больше'};
  $('#page-title').textContent=titles[state.page]||'Мой кошелёк';
  applyTheme();
  $('#profile-switch').innerHTML=profileBar();
  $('#wallet-picker').innerHTML=walletOptions(wallet()?.id);
  $('#global-search').value=state.txFilters.search;
  document.querySelectorAll('[data-page]').forEach(b=>b.classList.toggle('active',b.dataset.page===state.page||(state.page==='transactions'&&b.dataset.page==='dashboard')));
  const pages={dashboard:renderDashboard,accounts:renderAccounts,overview:renderOverview,transactions:renderTransactions,budgets:renderBudgets,settings:renderSettings};
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
function renderDashboard(){
  const w=wallet(),month=state.focusMonth,{income,expense}=monthlyTotals(w,month),net=income-expense;
  const recent=state.transactions.filter(t=>isWalletTx(t,w)&&t.date<=today()).sort(sortTx).slice(0,16);
  const todaySpent=sumType(state.transactions.filter(t=>t.date===today()),'expense',w);
  const todayCashback=cashbackTotals(state.transactions.filter(t=>t.date===today()),w).cashback;
  const monthlyCashback=cashbackTotals(state.transactions.filter(t=>t.date.startsWith(month)),w).cashback;
  const nextAvailable=month<today().slice(0,7);
  return `<div class="home-screen">
    <section class="home-summary" aria-label="Денежный поток за ${esc(monthTitle(month))}">
      <div class="hero-main"><div class="net-title"><div class="net-number">${esc(format(net,w.currency))}</div><div class="net-caption">Денежный поток · ${esc(monthTitle(month,true))}</div></div>
      <div class="flow-totals"><span class="inflow">${svgIcon('up')} ${esc(format(income,w.currency))}</span><span class="outflow">${svgIcon('down')} ${esc(format(expense,w.currency))}</span></div></div>
      <div class="home-cashback">🎁 Выгода от кешбэка: <strong>${esc(format(monthlyCashback,w.currency))}</strong></div><div class="chart-wrap">${cashFlowChart(w)}</div>
      <div class="month-navigation"><button data-action="prev-month" aria-label="Предыдущий месяц">${svgIcon('chevron','flip')}<span>${esc(monthTitle(moveMonth(month,-1)))}</span></button>
      <button class="selected-month" data-action="current-month" title="Вернуться к текущему месяцу">${esc(monthTitle(month,true))}${month===today().slice(0,7)?'<span class="now-badge">Этот месяц</span>':''}</button>
      <button data-action="next-month" aria-label="Следующий месяц" ${nextAvailable?'':'disabled'}><span>${nextAvailable?esc(monthTitle(moveMonth(month,1))):' '}</span>${svgIcon('chevron')}</button></div>
    </section>
    <div class="home-quick"><button class="quick-scan" data-action="scan-expense">${svgIcon('camera')} Добавить расход по скриншоту</button><span class="daily-spent">Сегодня потрачено: ${esc(format(todaySpent,w.currency))}${todayCashback?` · кешбэк +${esc(format(todayCashback,w.currency))}`:''}</span></div>
    <section class="home-activity"><div class="activity-heading"><h2>Последние операции</h2><button data-action="show-transactions">Все операции ${svgIcon('chevron')}</button></div>${groupedOperations(recent,w,16)}</section>
    <div class="data-footnote">${state.transactions.length?`В базе ${state.transactions.length.toLocaleString('ru-RU')} операций`:'История Spendee загружается в разделе «Больше»'} · данные сохраняются в браузере</div>
  </div>`;
}
function renderAccounts(){
  return `<div class="page-section"><div class="section-title"><h2>Мои счета</h2><div class="inline-actions"><button class="btn small" data-action="add-deposit">+ Вклад</button><button class="btn primary small" data-action="add-wallet">+ Счёт</button></div></div>
   <p class="tiny muted">Баланс рассчитан из всех записанных операций и начального остатка. Исторические доходы из Spendee не обязательно отражают сумму на реальном банковском счёте.</p>
   <div class="account-cards">${state.wallets.filter(w=>state.profileId==='family'||ownerOfWallet(w)===state.profileId).map(w=>`<div class="account-card ${w.id===wallet()?.id?'selected':''}"><div class="account-head"><span class="account-symbol">${svgIcon('wallet')}</span><div><div class="account-name">${esc(w.name)}</div><div class="account-currency">${esc(w.currency)} · ${esc(OWNERS[ownerOfWallet(w)])}${w.kind==='deposit'?' · вклад':''}</div></div></div>    <div class="account-balance">${esc(format(balance(w),w.currency))}</div>${w.kind==='deposit'?`<div class="deposit-small">${w.status==='closed'?'Архив · не текущий остаток · ':''}${esc(w.bank||'Банк не указан')} · ${Number(w.rate||0)}% годовых · до ${esc(w.maturityDate?shortDate(w.maturityDate):'бессрочно')}</div>`:''}<div class="account-actions"><button class="btn small ${w.id===wallet()?.id?'primary':''}" data-action="choose-wallet" data-id="${esc(w.id)}">${w.id===wallet()?.id?'Выбран':'Выбрать'}</button><button class="btn small" data-action="edit-wallet" data-id="${esc(w.id)}">Изменить</button></div></div>`).join('')}</div>
   <section class="panel deposit-help"><div class="panel-header"><h2>Вклады и проценты</h2><button class="btn small" data-action="download-deposit-template">Скачать шаблон CSV</button></div>
   <p class="tiny muted">Вклад — отдельный счёт, а не доход. Доходом считаются только полученные проценты. Старые и текущие вклады можно добавить вручную или импортировать списком из CSV.</p>
   <div class="inline-actions"><button class="btn primary small" data-action="add-deposit">+ Новый вклад</button><button class="btn small" data-action="add-interest">+ Начисление процентов</button></div>
   <label class="field" style="margin-top:15px">Импорт списка вкладов (CSV)<input type="file" id="deposit-csv-file" accept=".csv,text/csv" /></label>
   <p class="tiny muted">Начальный остаток вклада не прибавляется к доходам. Если деньги были переведены с другой карты, учти этот перевод отдельно, чтобы не увеличить общие активы дважды.</p></section>
   <section class="panel account-help"><h2>Расходы по скриншоту</h2><p class="tiny muted">Сфотографируйте банковскую операцию, проверьте распознанную сумму и сохраните расход в выбранный счёт.</p><button class="btn primary" data-action="scan-expense">${svgIcon('camera')} Сканировать операцию</button></section>
  </div>`;
}
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
  <select id="tx-kind">${opt('all','Все типы',f.kind==='all')}${opt('income','Доходы',f.kind==='income')}${opt('expense','Расходы',f.kind==='expense')}${opt('transfer','Переводы',f.kind==='transfer')}</select>
  <select id="tx-category">${categoryOptions('all',f.category,true)}</select></div>
  <div class="toolbar"><input id="tx-from" type="date" aria-label="Дата с" value="${esc(f.from)}"/><input id="tx-to" type="date" aria-label="Дата по" value="${esc(f.to)}"/><input id="tx-min" type="number" min="0" step="0.01" placeholder="Сумма от" value="${esc(f.min)}"/><input id="tx-max" type="number" min="0" step="0.01" placeholder="Сумма до" value="${esc(f.max)}"/><button class="btn small" data-action="clear-filters">Сбросить</button></div>
  <div id="tx-list">${transactionList()}</div></section>`; }
function renderBudgets(){
  const w=wallet(),currentMonth=today().slice(0,7),relevant=state.budgets.filter(b=>state.profileId==='family'||(b.ownerId||ownerOfWallet(state.wallets.find(x=>x.id===b.walletId)))===state.profileId);
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
 <section class="panel"><div class="panel-header"><h2>Данные и устройство</h2></div><button class="btn" data-action="go-accounts">Перейти к счетам</button><div class="settings-stat">${state.transactions.length.toLocaleString('ru-RU')} операций · ${state.wallets.length} счетов</div></section>
 <section class="panel"><div class="panel-header"><h2>Категории</h2><button class="btn small" data-action="add-category">+ Категория</button></div><p class="tiny muted">${income} доходных · ${expense} расходных</p>
 <input id="category-search" type="search" placeholder="Поиск категории" aria-label="Поиск категории" style="width:100%;margin-bottom:12px"/><div class="category-list" id="category-list">${categoryList('')}</div></section>
 <section class="panel"><div class="panel-header"><h2>Резервная копия</h2></div><div class="setting-block"><button class="btn primary" data-action="backup-json">Скачать полную копию JSON</button><button class="btn" data-action="export-csv">Экспорт операций CSV</button></div></section>
 </div>`;
}
function categoryList(query){
  const items=state.categories.filter(c=>c.name.toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru'))).sort((a,b)=>a.name.localeCompare(b.name,'ru'));
  return items.slice(0,200).map(c=>`<div class="list-row"><div class="row-left"><span class="cat-dot" style="background:${esc(c.color)}22;color:${esc(c.color)}">●</span><div><div class="row-title">${esc(c.name)}</div><div class="row-sub">${c.type==='income'?'Доход':'Расход'}</div></div></div><button class="btn small" data-action="edit-category" data-id="${esc(c.id)}">✎</button></div>`).join('')||'<div class="empty">Ничего не найдено</div>';
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

function openTransaction(id,preferredType='expense',presetCategory=''){
 const t=state.transactions.find(x=>x.id===id);editingType=t?.type||preferredType;
 const w=state.wallets.find(x=>x.id===t?.walletId)||wallet();
 const body=`<div class="type-tabs">${['expense','income','transfer'].map((v,i)=>`<button type="button" class="type-tab ${editingType===v?'active':''}" data-action="type-tab" data-type="${v}">${['Расход','Доход','Перевод'][i]}</button>`).join('')}</div><form id="tx-form" data-id="${esc(t?.id||'')}">
 <div class="form-grid">${field('Сумма',`<input name="amount" type="number" inputmode="decimal" min="0.01" step="0.01" value="${t?esc((t.amountMinor/100).toFixed(2)):''}" placeholder="0,00" required>`) }
 ${field('Дата',`<input name="date" type="date" value="${esc(t?.date||today())}" required>`) }
 ${field('Оплачено с карты / счёта',`<select name="wallet">${walletOptions(w.id)}</select>`) }
 ${field('Чей доход / расход',`<select name="owner">${ownerOptions(t?ownerOfTx(t):(state.profileId==='family'?state.deviceOwner:state.profileId))}</select>`) }
 ${cashbackFields(t)}
 <div id="tx-category-wrap">${field('Категория',`<select name="category"><option value="">Без категории</option>${categoryOptions(editingType,t?.categoryId||presetCategory)}</select>`)}</div>
 <div class="field wide ${editingType==='transfer'?'':'hidden'}" id="tx-destination">${field('В какой кошелёк',`<select name="toWallet"><option value="">Выберите</option>${walletOptions(t?.toWalletId||'', x=>x.id!==w.id&&x.currency===w.currency)}</select>`)}</div>
 ${field('Заметка',`<input name="note" maxlength="500" value="${esc(t?.note||'')}" placeholder="Необязательно">`,true)}
 ${field('Метки через запятую',`<input name="labels" value="${esc((t?.labels||[]).join(', '))}" placeholder="Например: работа, поездка">`,true)}</div>
 <div class="modal-actions">${t?`<button type="button" class="btn danger" data-action="delete-tx" data-id="${esc(t.id)}">Удалить</button>`:''}<button type="button" class="btn" data-action="close-modal">Отмена</button><button class="btn primary" type="submit">Сохранить</button></div></form>`;
 openModal(t?'Изменить операцию':'Новая операция',body);
 if(editingType==='transfer') updateTransactionType();
 updateCashbackPreview($('#tx-form'),'init');
}
function updateTransactionType(){
 document.querySelectorAll('.type-tab').forEach(b=>b.classList.toggle('active',b.dataset.type===editingType));
 const wrap=$('#tx-category-wrap'),dest=$('#tx-destination');if(!wrap)return;
 wrap.classList.toggle('hidden',editingType==='transfer');dest.classList.toggle('hidden',editingType!=='transfer');
 const cb=$('#tx-cashback-wrap');if(cb)cb.classList.toggle('hidden',editingType!=='expense');
 const old=wrap.querySelector('select');if(old)old.innerHTML=`<option value="">Без категории</option>`+categoryOptions(editingType);
}
let quickType='income';
const iconForCategory=c=>{
 const n=c.name.toLocaleLowerCase('ru');
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
 const list=state.categories.filter(c=>c.type===quickType&&c.name.toLocaleLowerCase('ru').includes(q))
   .sort((a,b)=>(counts.get(b.id)||0)-(counts.get(a.id)||0)||a.name.localeCompare(b.name,'ru'));
 return list.map(c=>`<button class="quick-cat" type="button" data-action="choose-quick-category" data-id="${esc(c.id)}" title="${esc(c.name)} · ${(counts.get(c.id)||0)} операций">
   <span class="quick-cat-icon" style="--cat-color:${/^#[0-9a-fA-F]{6}$/.test(c.color)?c.color:'#6e9fc9'}">${iconForCategory(c)}</span>
   <span class="quick-cat-name">${esc(c.name)}</span><span class="quick-cat-count">${(counts.get(c.id)||0).toLocaleString('ru-RU')}</span></button>`).join('')||'<div class="empty">Категории не найдены. Добавь её в «Больше» или измени поиск.</div>';
}
function openQuickAdd(type='income'){
 quickType=type;
 openModal('Новая операция',`<div class="quick-categories">
   <div class="category-tabs"><button data-action="quick-type" data-type="expense" class="${quickType==='expense'?'active':''}">Расходы</button><button data-action="quick-type" data-type="income" class="${quickType==='income'?'active':''}">Доходы</button><button data-action="quick-type" data-type="transfer" class="${quickType==='transfer'?'active':''}">Перевод</button></div>
   <label class="category-find">🔎 <input id="quick-category-search" type="search" autocomplete="off" placeholder="Найти категорию…" aria-label="Поиск категории" /></label>
   <div class="quick-category-meta">Сначала самые частые категории за всё время</div>
   <div class="quick-category-grid" id="quick-category-grid">${quickCategoryItems()}</div>
   <div class="quick-category-actions"><button class="btn" data-action="quick-no-category">Без категории</button><button class="btn" data-action="scan-expense">📷 Со скриншота</button></div>
 </div>`);
 if(type==='transfer')refreshQuickCategoryPicker();
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
 ${field('Чей расход',`<select name="owner">${ownerOptions(state.profileId==='family'?state.deviceOwner:state.profileId)}</select>`)}
 ${field('Категория',`<select name="category"><option value="">Без категории</option>${categoryOptions('expense')}</select>`)}
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
 ${field('Для чьего бюджета',`<select name="owner">${ownerOptions(b?.ownerId||ownerOfWallet(state.wallets.find(x=>x.id===b?.walletId))||(state.profileId==='family'?state.deviceOwner:state.profileId))}</select>`)}
 ${field('Кошелёк-ориентир',`<select name="wallet">${walletOptions(b?.walletId||w.id)}</select>`)}
 ${field('Категория',`<select name="category">${opt('','Все расходы',!b?.categoryId)}${categoryOptions('expense',b?.categoryId||'')}</select>`,true)}
 <div class="modal-actions wide"><button type="button" class="btn" data-action="close-modal">Отмена</button><button class="btn primary" type="submit">Сохранить</button></div></form>`);
}
function openWallet(id){
 const w=state.wallets.find(x=>x.id===id);
 openModal(w?'Редактировать кошелёк':'Новый кошелёк',`<form id="wallet-form" data-id="${esc(id||'')}" class="form-grid">
 ${field('Название',`<input name="name" value="${esc(w?.name||'')}" required>`,true)}
 ${field('Валюта',`<select name="currency" ${w?'disabled':''}>${['RUB','EUR','USD','GBP','KZT','BYN','UAH'].map(v=>opt(v,v,v===(w?.currency||'RUB'))).join('')}</select>`)}
 ${field('Владелец счёта',`<select name="owner">${ownerOptions(w?ownerOfWallet(w):(state.profileId==='family'?state.deviceOwner:state.profileId))}</select>`)}
 ${field('Начальный баланс',`<input name="initial" type="number" step="0.01" value="${w?esc((w.initialBalanceMinor||0)/100):'0'}" required>`)}
 ${w?.kind==='deposit'?`${field('Банк',`<input name="bank" maxlength="80" value="${esc(w.bank||'')}" required>`)}${field('Ставка годовых, %',`<input name="rate" type="number" min="0" max="100" step="0.01" value="${esc(w.rate||0)}">`)}${field('Дата окончания',`<input name="maturityDate" type="date" value="${esc(w.maturityDate||'')}">`)}${field('Состояние',`<select name="status">${opt('open','Действует',w.status!=='closed')}${opt('closed','Архивный / закрыт',w.status==='closed')}</select>`)}`:''}
 <p class="tiny muted wide">Начальный баланс — сумма до первой внесённой операции. После импорта истории обычно равен 0, если данные полные.</p>
 <div class="modal-actions wide"><button type="button" class="btn" data-action="close-modal">Отмена</button><button class="btn primary" type="submit">Сохранить</button></div></form>`);
}
// Вклад является счётом. Перенос тела вклада — перевод, не доход.
function openDeposit(){
 openModal('Новый вклад',`<form id="deposit-form" class="form-grid">
 ${field('Банк',`<input name="bank" maxlength="80" placeholder="Например, Т-Банк" required>`,true)}
 ${field('Название вклада',`<input name="name" maxlength="100" placeholder="Накопительный, Вклад на 6 месяцев" required>`,true)}
 ${field('Чей вклад',`<select name="owner">${ownerOptions(state.profileId==='family'?state.deviceOwner:state.profileId)}</select>`)}
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
 const deposits=state.wallets.filter(w=>w.kind==='deposit'&&(state.profileId==='family'||ownerOfWallet(w)===state.profileId));
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
 const c=state.categories.find(x=>x.id===id);
 openModal(c?'Редактировать категорию':'Новая категория',`<form id="category-form" data-id="${esc(id||'')}" class="form-grid">
 ${field('Название',`<input name="name" value="${esc(c?.name||'')}" required>`,true)}
 ${field('Тип',`<select name="type" ${c?'disabled':''}>${opt('income','Доход',c?.type==='income')}${opt('expense','Расход',c?.type==='expense'||!c)}</select>`)}
 ${field('Цвет',`<input type="color" name="color" value="${esc(c?.color||'#36a584')}">`)}
 <div class="modal-actions wide"><button type="button" class="btn" data-action="close-modal">Отмена</button><button class="btn primary" type="submit">Сохранить</button></div></form>`);
}
async function submitTransaction(form){
 const data=new FormData(form),existing=state.transactions.find(t=>t.id===form.dataset.id);
 const amount=Math.round(Number(data.get('amount'))*100),w=state.wallets.find(x=>x.id===data.get('wallet'));
 if(!w||!Number.isSafeInteger(amount)||amount<=0) return toast('Укажите корректную сумму и кошелёк.');
 const date=String(data.get('date'));
 if(!parseDate(date))return toast('Неверная дата.');
 const dest=state.wallets.find(x=>x.id===data.get('toWallet'));
 if(editingType==='transfer'&&(!dest||dest.id===w.id||dest.currency!==w.currency))return toast('Для перевода выберите другой кошелёк в той же валюте.');
 const cashback=editingType==='expense'?cashbackFormData(form,amount,existing):{cashbackMinor:0,cashbackStatus:'expected',cashbackDate:null};
 if(!cashback)return toast('Кешбэк должен быть от 0 до 100% стоимости покупки.');
 const item={...existing,...cashback,id:existing?.id||uid(),walletId:w.id,toWalletId:editingType==='transfer'?dest.id:null,amountMinor:amount,toAmountMinor:editingType==='transfer'?amount:null,type:editingType,ownerId:String(data.get('owner')||state.deviceOwner),date,categoryId:editingType==='transfer'?null:String(data.get('category')||'')||null,note:cleanName(data.get('note')),labels:String(data.get('labels')||'').split(',').map(cleanName).filter(Boolean),createdAt:existing?.createdAt||new Date().toISOString()};
 await save('transactions',item);await loadData();closeModal();render();toast('Операция сохранена.');
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
 const c={id:old?.id||uid(),name:cleanName(f.get('name')),type:old?.type||f.get('type'),color:f.get('color')};
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
  if(e.target.closest('#floating-add')){openQuickAdd('income');return;}
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

   if(a==='show-transactions'){setPage('transactions');return;}
   if(a==='go-accounts'){setPage('accounts');return;}
   if(a==='select-profile'){
    state.profileId=id;saveLocal(FAMILY_KEY,id);state.walletId=null;render();return;
   }
   if(a==='switch-device-profile'){
    state.profileId=state.deviceOwner;state.walletId=null;saveLocal(FAMILY_KEY,state.profileId);render();return;
   }
   if(a==='quick-type'){quickType=el.dataset.type;refreshQuickCategoryPicker();return;}
   if(a==='choose-quick-category'){const chosen=state.categories.find(c=>c.id===id&&c.type===quickType);if(chosen){closeModal();openTransaction(null,quickType,id);}return;}
   if(a==='quick-no-category'){closeModal();openTransaction(null,quickType);return;}
   if(a==='quick-income'||a==='quick-expense'||a==='quick-transfer'){closeModal();openTransaction(null,a==='quick-income'?'income':a==='quick-transfer'?'transfer':'expense');return;}
   if(a==='add-deposit'){openDeposit();return;}
   if(a==='add-interest'){openDepositInterest();return;}
   if(a==='download-deposit-template'){downloadDepositTemplate();return;}
   if(a==='prev-month'){state.focusMonth=moveMonth(state.focusMonth,-1);state.period='month';render();return;}
   if(a==='next-month'){if(state.focusMonth<today().slice(0,7))state.focusMonth=moveMonth(state.focusMonth,1);state.period='month';render();return;}
   if(a==='current-month'){state.focusMonth=today().slice(0,7);state.period='month';render();return;}
   if(a==='select-month'){if(el.dataset.month){state.focusMonth=el.dataset.month;state.period='month';render();}return;}
   if(a==='add-tx'){openTransaction();return;}
   if(a==='scan-expense'){closeModal();openScreenshotExpense();return;}
   if(a==='edit-tx'){openTransaction(id);return;}
   if(a==='delete-tx'){
    if(confirm('Удалить эту операцию без возможности отмены?')){await remove('transactions',id);await loadData();closeModal();render();toast('Операция удалена.');}return;
   }
   if(a==='type-tab'){editingType=el.dataset.type;updateTransactionType();return;}
   if(a==='more-tx'){state.maxTx+=100;$('#tx-list').innerHTML=transactionList();return;}
   if(a==='clear-filters'){state.txFilters={search:'',category:'all',kind:'all',from:'',to:'',min:'',max:''};state.maxTx=100;render();return;}
   if(a==='add-budget'){openBudget();return;}
   if(a==='edit-budget'){openBudget(id);return;}
   if(a==='delete-budget') {if(confirm('Удалить бюджет?')){await remove('budgets',id);await loadData();render();}return;}
   if(a==='add-wallet'){openWallet();return;}
   if(a==='edit-wallet'){openWallet(id);return;}
   if(a==='choose-wallet'){state.walletId=id;render();return;}
   if(a==='add-category'){openCategory();return;}
   if(a==='edit-category'){openCategory(id);return;}
   if(a==='backup-json'){backupJSON();return;}
   if(a==='export-csv'){exportCSV();return;}
  }catch(err){console.error(err);toast('Ошибка: '+err.message);}
 });
 document.addEventListener('submit',async e=>{
  const f=e.target;if(!['tx-form','budget-form','wallet-form','category-form','import-form','ocr-expense-form','deposit-form','deposit-interest-form','cloud-auth-form','cloud-create-form','cloud-join-form'].includes(f.id))return;
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
    if(f.id==='tx-form')await submitTransaction(f);if(f.id==='ocr-expense-form')await submitOcrExpense(f);if(f.id==='budget-form')await submitBudget(f);if(f.id==='wallet-form')await submitWallet(f);if(f.id==='category-form')await submitCategory(f);if(f.id==='import-form')await doCSVImport(f);if(f.id==='deposit-form')await submitDeposit(f);if(f.id==='deposit-interest-form')await submitDepositInterest(f);}
  catch(err){console.error(err);toast('Ошибка: '+err.message);}
  finally{if(btn&&btn.isConnected)btn.disabled=false;}
 });
 document.addEventListener('change',async e=>{
  const el=e.target,id=el.id;
  if(id==='wallet-picker'){state.walletId=el.value;render();return;}
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
  if(e.target.id==='category-search'){$('#category-list').innerHTML=categoryList(e.target.value);}
  if(e.target.id==='quick-category-search'){$('#quick-category-grid').innerHTML=quickCategoryItems(e.target.value);}
 });
 document.addEventListener('keydown',e=>{if(e.key==='Escape')closeModal(); if((e.key==='Enter'||e.key===' ')&&e.target.matches('[data-action=select-month]')){e.preventDefault();e.target.click();}});
  $('#open-filters').addEventListener('click',()=>{setPage('transactions');document.getElementById('tx-search')?.focus();});
}
async function start(){
 try{cloud.init();await loadData();bind();cloud.onStatus(()=>{if(state.page==='settings')render();});window.addEventListener('cloud-changed',async()=>{await loadData();render();});render();if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js').catch(console.warn);}
 catch(e){console.error(e);$('#content').innerHTML=`<section class="panel">Ошибка открытия базы: ${esc(e.message)}. Проверьте, что сайт запущен по HTTPS или localhost и браузер разрешает IndexedDB.</section>`;}
}
start();
