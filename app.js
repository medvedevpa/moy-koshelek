import { getAll, save, remove, insertMany, replaceDatabase, uid } from './db.js';
import { readCSVFile, guessMapping, parseAmount, parseDate, parseType, csvEscape, fingerprint } from './import.js';
import { recognizeImage, parseScreenshot } from './ocr.js';

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
let state = { wallets:[], categories:[], transactions:[], budgets:[], page:'dashboard', walletId:null, period:'month', focusMonth:today().slice(0,7), txFilters:{search:'',category:'all',kind:'all',from:'',to:'',min:'',max:''}, maxTx:100, importRows:null, importHeaders:null, importMapping:null };

function wallet() { return state.wallets.find(w=>w.id === state.walletId) || state.wallets[0]; }
function cat(id) { return state.categories.find(c=>c.id===id); }
function walletName(id) { return state.wallets.find(w=>w.id===id)?.name || 'Кошелёк'; }
function isWalletTx(t,w) { return t.walletId===w.id || (t.type==='transfer' && t.toWalletId===w.id); }
function txDelta(t,w) {
  if (t.type==='income' && t.walletId===w.id) return t.amountMinor;
  if (t.type==='expense' && t.walletId===w.id) return -t.amountMinor;
  if (t.type==='transfer') return (t.toWalletId===w.id ? (t.toAmountMinor ?? t.amountMinor) : 0) - (t.walletId===w.id ? t.amountMinor : 0);
  return 0;
}
function balance(w, dateEnd='9999-12-31') { return (w.initialBalanceMinor||0) + state.transactions.filter(t=>t.date<=dateEnd).reduce((sum,t)=>sum+txDelta(t,w),0); }
function filteredByPeriod(w) { const start=datePeriod(); const end=state.period==='month'?state.focusMonth+'-31':today();return state.transactions.filter(t=>isWalletTx(t,w)&&(!start||t.date>=start)&&t.date<=end); }
function sumType(rows,type,w) { return rows.filter(t=>t.type===type && t.walletId===w.id).reduce((s,t)=>s+t.amountMinor,0); }
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
  if(!categories.length){
    const seed=[{id:uid(),name:'Другое',type:'income',color:'#50b9a1'},{id:uid(),name:'Другое',type:'expense',color:'#e66b80'}];
    await insertMany('categories',seed);state.categories=seed;
  }
  if (!state.wallets.some(w=>w.id===state.walletId)) state.walletId=state.wallets[0].id;
}
function toast(message){const t=$('#toast');t.textContent=message;t.classList.add('visible');clearTimeout(toast.timer);toast.timer=setTimeout(()=>t.classList.remove('visible'),3500);}
function render(){
  const titles={dashboard:'Главная',accounts:'Счета',overview:'Обзор',transactions:'История',budgets:'Бюджеты',settings:'Больше'};
  $('#page-title').textContent=titles[state.page]||'Мой кошелёк';
  $('#wallet-picker').innerHTML=walletOptions(state.walletId);
  $('#global-search').value=state.txFilters.search;
  document.querySelectorAll('[data-page]').forEach(b=>b.classList.toggle('active',b.dataset.page===state.page||(state.page==='transactions'&&b.dataset.page==='dashboard')));
  const pages={dashboard:renderDashboard,accounts:renderAccounts,overview:renderOverview,transactions:renderTransactions,budgets:renderBudgets,settings:renderSettings};
  $('#content').innerHTML=pages[state.page]();
}
function monthlyTotals(w,month){
  const rows=state.transactions.filter(t=>t.date.startsWith(month)&&t.walletId===w.id);
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
    const net=dayRows.reduce((sum,t)=>sum+txDelta(t,w),0);
    const dayContent=dayRows.map(t=>{
      const amount=txDelta(t,w),name=t.type==='transfer'?`Перевод · ${walletName(t.toWalletId||t.walletId)}`:cat(t.categoryId)?.name||'Без категории';
      const detail=String(t.note||'').trim();
      const symbol=t.type==='income'?'up':t.type==='expense'?'down':'transfer';
      return `<button class="activity-operation" data-action="edit-tx" data-id="${esc(t.id)}" aria-label="Изменить: ${esc(name)}, ${esc(format(amount,w.currency))}">
        <span class="operation-icon ${esc(t.type)}">${svgIcon(symbol)}</span>
        <span class="operation-text"><span class="operation-name">${esc(name)}</span>${detail?`<span class="operation-note">${esc(detail)}</span>`:''}</span>
        <span class="operation-money ${amount>=0?'positive':'negative'}">${esc(format(amount,w.currency))}</span>
      </button>`;
    }).join('');
    return `<section class="activity-day"><div class="day-header"><span>${esc(dayTitle(date))}</span><span>${esc(format(net,w.currency))}</span></div><div class="day-operations">${dayContent}</div></section>`;
  }).join('');
}
function renderDashboard(){
  const w=wallet(),month=state.focusMonth,{income,expense}=monthlyTotals(w,month),net=income-expense;
  const recent=state.transactions.filter(t=>isWalletTx(t,w)&&t.date<=today()).sort(sortTx).slice(0,16);
  const todaySpent=sumType(state.transactions.filter(t=>t.date===today()),'expense',w);
  const nextAvailable=month<today().slice(0,7);
  return `<div class="home-screen">
    <section class="home-summary" aria-label="Денежный поток за ${esc(monthTitle(month))}">
      <div class="hero-main"><div class="net-title"><div class="net-number">${esc(format(net,w.currency))}</div><div class="net-caption">Денежный поток · ${esc(monthTitle(month,true))}</div></div>
      <div class="flow-totals"><span class="inflow">${svgIcon('up')} ${esc(format(income,w.currency))}</span><span class="outflow">${svgIcon('down')} ${esc(format(expense,w.currency))}</span></div></div>
      <div class="chart-wrap">${cashFlowChart(w)}</div>
      <div class="month-navigation"><button data-action="prev-month" aria-label="Предыдущий месяц">${svgIcon('chevron','flip')}<span>${esc(monthTitle(moveMonth(month,-1)))}</span></button>
      <button class="selected-month" data-action="current-month" title="Вернуться к текущему месяцу">${esc(monthTitle(month,true))}${month===today().slice(0,7)?'<span class="now-badge">Этот месяц</span>':''}</button>
      <button data-action="next-month" aria-label="Следующий месяц" ${nextAvailable?'':'disabled'}><span>${nextAvailable?esc(monthTitle(moveMonth(month,1))):' '}</span>${svgIcon('chevron')}</button></div>
    </section>
    <div class="home-quick"><button class="quick-scan" data-action="scan-expense">${svgIcon('camera')} Добавить расход по скриншоту</button><span class="daily-spent">Сегодня потрачено: ${esc(format(todaySpent,w.currency))}</span></div>
    <section class="home-activity"><div class="activity-heading"><h2>Последние операции</h2><button data-action="show-transactions">Все операции ${svgIcon('chevron')}</button></div>${groupedOperations(recent,w,16)}</section>
    <div class="data-footnote">${state.transactions.length?`В базе ${state.transactions.length.toLocaleString('ru-RU')} операций`:'История Spendee загружается в разделе «Больше»'} · данные сохраняются в браузере</div>
  </div>`;
}
function renderAccounts(){
  return `<div class="page-section"><div class="section-title"><h2>Мои счета</h2><button class="btn primary small" data-action="add-wallet">+ Счёт</button></div>
   <p class="tiny muted">Баланс рассчитан из всех записанных операций и начального остатка. Исторические доходы из Spendee не обязательно отражают сумму на реальном банковском счёте.</p>
   <div class="account-cards">${state.wallets.map(w=>`<div class="account-card ${w.id===state.walletId?'selected':''}"><div class="account-head"><span class="account-symbol">${svgIcon('wallet')}</span><div><div class="account-name">${esc(w.name)}</div><div class="account-currency">${esc(w.currency)}</div></div></div><div class="account-balance">${esc(format(balance(w),w.currency))}</div><div class="account-actions"><button class="btn small ${w.id===state.walletId?'primary':''}" data-action="choose-wallet" data-id="${esc(w.id)}">${w.id===state.walletId?'Выбран':'Выбрать'}</button><button class="btn small" data-action="edit-wallet" data-id="${esc(w.id)}">Изменить</button></div></div>`).join('')}</div>
   <section class="panel account-help"><h2>Расходы по скриншоту</h2><p class="tiny muted">Сфотографируйте банковскую операцию, проверьте распознанную сумму и сохраните расход в выбранный счёт.</p><button class="btn primary" data-action="scan-expense">${svgIcon('camera')} Сканировать операцию</button></section>
  </div>`;
}
function renderOverview(){
 const w=wallet(),rows=filteredByPeriod(w),income=sumType(rows,'income',w),expense=sumType(rows,'expense',w);
 return `<div class="page-section"><div class="section-title"><h2>Финансовый обзор</h2><select id="period-picker" aria-label="Период">${opt('month','Выбранный месяц',state.period==='month')}${opt('year','Этот год',state.period==='year')}${opt('all','Вся история',state.period==='all')}</select></div>
 <div class="overview-month-hint">${state.period==='month'?esc(monthTitle(state.focusMonth,true)):state.period==='year'?'С начала года':'За весь период'} · ${rows.length.toLocaleString('ru-RU')} операций</div>
 <div class="stats"><div class="panel stat"><div class="label">Доходы</div><strong class="positive">+${esc(format(income,w.currency))}</strong></div><div class="panel stat"><div class="label">Расходы</div><strong class="negative">−${esc(format(expense,w.currency))}</strong></div><div class="panel stat"><div class="label">Разница</div><strong>${money(income-expense,w.currency)}</strong></div></div>
 <div class="dash-columns"><section class="panel section-gap"><div class="panel-header"><h2>Доходы по категориям</h2><span class="tiny muted">Топ-7</span></div>${categoriesBar(rows,'income',w)}</section>
 <section class="panel section-gap"><div class="panel-header"><h2>Расходы по категориям</h2><span class="tiny muted">Топ-7</span></div>${categoriesBar(rows,'expense',w)}</section></div>
 <section class="panel section-gap"><div class="panel-header"><h2>История</h2><button data-action="show-transactions" class="btn small">Показать операции</button></div><p class="tiny muted">Подробный поиск и фильтры доступны в истории операций.</p></section>
 </div>`;
}
function categoriesBar(rows,type,w){
  const sums=new Map();
  rows.filter(t=>t.type===type&&t.walletId===w.id).forEach(t=>sums.set(t.categoryId,(sums.get(t.categoryId)||0)+t.amountMinor));
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
    const delta=Math.abs(txDelta(t,w));
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
  const w=wallet(),currentMonth=today().slice(0,7),relevant=state.budgets.filter(b=>b.walletId===w.id);
  return `<section class="panel section-gap"><div class="panel-header"><div><h2>Лимиты расходов</h2><p class="tiny muted" style="margin:7px 0 0">Текущий месяц · ${esc(w.name)}</p></div><button class="btn primary small" data-action="add-budget">+ Бюджет</button></div>
  ${relevant.length?relevant.map(b=>{
    const used=state.transactions.filter(t=>t.walletId===w.id&&t.type==='expense'&&t.date.startsWith(currentMonth)&&(!b.categoryId||t.categoryId===b.categoryId)).reduce((s,t)=>s+t.amountMinor,0);
    const ratio=used/b.limitMinor;
    return `<div class="budget-item"><div class="bar-line"><span>${esc(b.name)}</span><span>${Math.round(ratio*100)}%</span></div>
    <div class="tiny muted" style="margin:8px 0 12px">${esc(format(used,w.currency))} из ${esc(format(b.limitMinor,w.currency))} · ${esc(cat(b.categoryId)?.name||'Все расходы')}</div>
    <div class="progress"><div class="progress-fill ${ratio>=1?'over':ratio>=.75?'warning':''}" style="width:${Math.min(100,ratio*100)}%"></div></div><div class="actions-right" style="margin-top:10px"><button class="btn small" data-action="edit-budget" data-id="${esc(b.id)}">Изменить</button><button class="btn small danger" data-action="delete-budget" data-id="${esc(b.id)}">Удалить</button></div></div>`;}).join(''):'<div class="empty"><strong>Пока нет бюджетов</strong>Создайте месячный лимит расходов на категорию или все расходы.</div>'}</section>`;
}
function renderSettings(){
 const w=wallet();const income=state.categories.filter(c=>c.type==='income').length,expense=state.categories.filter(c=>c.type==='expense').length;
 return `<div class="grid-two"><section class="panel"><div class="panel-header"><h2>Данные и устройство</h2></div><p class="tiny muted">История хранится только в этом браузере. Для переноса на другой телефон скачайте резервную копию JSON внизу.</p><button class="btn" data-action="go-accounts">Перейти к счетам</button><div class="settings-stat">${state.transactions.length.toLocaleString('ru-RU')} операций · ${state.wallets.length} счетов</div></section>
 <section class="panel"><div class="panel-header"><h2>Категории</h2><button class="btn small" data-action="add-category">+ Категория</button></div><p class="tiny muted">${income} доходных · ${expense} расходных. Можно импортировать локальный справочник из HTML Spendee.</p>
 <label class="field tiny" style="margin-bottom:12px">Загрузить категории из JSON<input type="file" id="categories-seed-file" accept=".json,application/json"/></label><input id="category-search" type="search" placeholder="Поиск категории" style="width:100%;margin-bottom:12px"/><div class="category-list" id="category-list">${categoryList('')}</div></section>
 <section class="panel"><div class="panel-header"><h2>Импорт из Spendee</h2></div><div class="setting-block"><p class="muted tiny">Экспортируйте историю в CSV через мобильный Spendee. Затем выберите файл здесь: данные обработаются прямо в браузере.</p><input type="file" id="csv-file" accept=".csv,text/csv,text/plain"/><div class="hint">Импорт поддерживает CSV с разделителями запятая / точка с запятой / табуляция. Дату, сумму, категорию и другие поля можно сопоставить вручную. XLS пока не поддерживается.</div></div></section>
 <section class="panel"><div class="panel-header"><h2>Резервная копия</h2></div><div class="setting-block"><p class="muted tiny">Все записи находятся в IndexedDB браузера. Очистка данных сайта может удалить историю — регулярно сохраняйте резервные копии.</p><button class="btn primary" data-action="backup-json">Скачать полную копию JSON</button><button class="btn" data-action="export-csv">Экспорт операций CSV</button><label class="field">Восстановить из JSON<input type="file" id="restore-file" accept="application/json,.json"/></label><div class="hint">Восстановление полностью заменит текущую базу данных. Копия JSON не зашифрована — храните её в безопасном месте.</div></div></section>
 </div><p class="tiny muted" style="margin-top:20px">Первая версия: без облачной синхронизации, банковских подключений и автоматических повторений. Для установки как PWA нужен HTTPS или localhost.</p>`;
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
function openTransaction(id,preferredType='expense'){
 const t=state.transactions.find(x=>x.id===id);editingType=t?.type||preferredType;
 const w=state.wallets.find(x=>x.id===t?.walletId)||wallet();
 const body=`<div class="type-tabs">${['expense','income','transfer'].map((v,i)=>`<button type="button" class="type-tab ${editingType===v?'active':''}" data-action="type-tab" data-type="${v}">${['Расход','Доход','Перевод'][i]}</button>`).join('')}</div><form id="tx-form" data-id="${esc(t?.id||'')}">
 <div class="form-grid">${field('Сумма',`<input name="amount" type="number" inputmode="decimal" min="0.01" step="0.01" value="${t?esc((t.amountMinor/100).toFixed(2)):''}" placeholder="0,00" required>`) }
 ${field('Дата',`<input name="date" type="date" value="${esc(t?.date||today())}" required>`) }
 ${field('Кошелёк',`<select name="wallet">${walletOptions(w.id)}</select>`) }
 <div id="tx-category-wrap">${field('Категория',`<select name="category"><option value="">Без категории</option>${categoryOptions(editingType,t?.categoryId||'')}</select>`)}</div>
 <div class="field wide ${editingType==='transfer'?'':'hidden'}" id="tx-destination">${field('В какой кошелёк',`<select name="toWallet"><option value="">Выберите</option>${walletOptions(t?.toWalletId||'', x=>x.id!==w.id&&x.currency===w.currency)}</select>`)}</div>
 ${field('Заметка',`<input name="note" maxlength="500" value="${esc(t?.note||'')}" placeholder="Необязательно">`,true)}
 ${field('Метки через запятую',`<input name="labels" value="${esc((t?.labels||[]).join(', '))}" placeholder="Например: работа, поездка">`,true)}</div>
 <div class="modal-actions">${t?`<button type="button" class="btn danger" data-action="delete-tx" data-id="${esc(t.id)}">Удалить</button>`:''}<button type="button" class="btn" data-action="close-modal">Отмена</button><button class="btn primary" type="submit">Сохранить</button></div></form>`;
 openModal(t?'Изменить операцию':'Новая операция',body);
 if(editingType==='transfer') updateTransactionType();
}
function updateTransactionType(){
 document.querySelectorAll('.type-tab').forEach(b=>b.classList.toggle('active',b.dataset.type===editingType));
 const wrap=$('#tx-category-wrap'),dest=$('#tx-destination');if(!wrap)return;
 wrap.classList.toggle('hidden',editingType==='transfer');dest.classList.toggle('hidden',editingType!=='transfer');
 const old=wrap.querySelector('select');if(old)old.innerHTML=`<option value="">Без категории</option>`+categoryOptions(editingType);
}
function openQuickAdd(){
 openModal('Добавить операцию',`<div class="quick-add-grid">
  <button data-action="quick-income" class="quick-choice"><span class="quick-icon income">${svgIcon('up')}</span><span><strong>Доход</strong><small>Поступление денег</small></span>${svgIcon('chevron')}</button>
  <button data-action="quick-expense" class="quick-choice"><span class="quick-icon expense">${svgIcon('down')}</span><span><strong>Расход</strong><small>Записать покупку вручную</small></span>${svgIcon('chevron')}</button>
  <button data-action="scan-expense" class="quick-choice"><span class="quick-icon scan">${svgIcon('camera')}</span><span><strong>Со скриншота</strong><small>Распознать банковскую операцию</small></span>${svgIcon('chevron')}</button>
  <button data-action="quick-transfer" class="quick-choice"><span class="quick-icon transfer">${svgIcon('transfer')}</span><span><strong>Перевод</strong><small>Между своими счетами</small></span>${svgIcon('chevron')}</button>
 </div>`);
}
function openScreenshotExpense(){
 const w=wallet();
 openModal('Расход со скриншота', `<p class="muted tiny">Загрузите скриншот одной операции банка или чек. Распознавание выполняется на устройстве, без платного AI API. Проверьте сумму и дату до сохранения.</p>
 <label class="field">Скриншот (PNG, JPG, WEBP)<input type="file" id="ocr-image" accept="image/png,image/jpeg,image/webp,image/*" /></label>
 <div id="ocr-status" class="hint" style="margin-top:12px">Выберите изображение. Для первой загрузки OCR нужен интернет.</div>
 <form id="ocr-expense-form" class="hidden" style="margin-top:17px">
 <div class="form-grid">
 ${field('Сумма расхода',`<input required name="amount" type="number" min="0.01" step="0.01" inputmode="decimal" placeholder="0.00">`)}
 ${field('Дата',`<input required name="date" type="date" value="${today()}">`)}
 ${field('Кошелёк',`<select name="wallet">${walletOptions(w.id)}</select>`)}
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
  f.elements.date.value=parsed.date;
  f.elements.note.value=parsed.merchant.slice(0,500);
  $('#ocr-raw').textContent=raw||'(Текст не обнаружен)';
  status.textContent=parsed.amount?'Нашли возможную сумму. Обязательно проверьте распознанные данные.':'Сумма не найдена. Введите её вручную, сверившись со скриншотом.';
  f.classList.remove('hidden');
 }catch(e){if(status.isConnected)status.textContent='Ошибка распознавания: '+e.message+' Попробуйте другое изображение или добавьте расход вручную.';}
}
async function submitOcrExpense(form){
 const data=new FormData(form),amount=Math.round(Number(data.get('amount'))*100);
 const w=state.wallets.find(x=>x.id===data.get('wallet'));
 const date=String(data.get('date'));
 if(!Number.isSafeInteger(amount)||amount<=0||!w||!parseDate(date))return toast('Проверьте сумму, дату и кошелёк.');
 const note=cleanName(data.get('note'));
 // A soft warning prevents accidental duplicates without blocking valid repeated purchases.
 const duplicate=state.transactions.some(t=>t.type==='expense'&&t.walletId===w.id&&t.date===date&&t.amountMinor===amount&&cleanName(t.note).toLowerCase()===note.toLowerCase());
 if(duplicate&&!confirm('Очень похожий расход уже есть. Сохранить ещё один?'))return;
 await save('transactions',{id:uid(),type:'expense',walletId:w.id,toWalletId:null,amountMinor:amount,toAmountMinor:null,date,categoryId:String(data.get('category')||'')||null,note,labels:['скриншот'],createdAt:new Date().toISOString()});
 await loadData();closeModal();render();toast('Расход добавлен в статистику.');
}

function openBudget(id){
 const b=state.budgets.find(x=>x.id===id),w=wallet();
 openModal(b?'Изменить бюджет':'Новый бюджет',`<form id="budget-form" data-id="${esc(id||'')}" class="form-grid">
 ${field('Название',`<input name="name" value="${esc(b?.name||'')}" placeholder="Например, маркетинг" required>`,true)}
 ${field('Лимит за месяц',`<input name="limit" type="number" min="0.01" step="0.01" inputmode="decimal" value="${b?esc(b.limitMinor/100):''}" required>`)}
 ${field('Кошелёк',`<select name="wallet">${walletOptions(b?.walletId||w.id)}</select>`)}
 ${field('Категория',`<select name="category">${opt('','Все расходы',!b?.categoryId)}${categoryOptions('expense',b?.categoryId||'')}</select>`,true)}
 <div class="modal-actions wide"><button type="button" class="btn" data-action="close-modal">Отмена</button><button class="btn primary" type="submit">Сохранить</button></div></form>`);
}
function openWallet(id){
 const w=state.wallets.find(x=>x.id===id);
 openModal(w?'Редактировать кошелёк':'Новый кошелёк',`<form id="wallet-form" data-id="${esc(id||'')}" class="form-grid">
 ${field('Название',`<input name="name" value="${esc(w?.name||'')}" required>`,true)}
 ${field('Валюта',`<select name="currency" ${w?'disabled':''}>${['RUB','EUR','USD','GBP','KZT','BYN','UAH'].map(v=>opt(v,v,v===(w?.currency||'RUB'))).join('')}</select>`)}
 ${field('Начальный баланс',`<input name="initial" type="number" step="0.01" value="${w?esc((w.initialBalanceMinor||0)/100):'0'}" required>`)}
 <p class="tiny muted wide">Начальный баланс — сумма до первой внесённой операции. После импорта истории обычно равен 0, если данные полные.</p>
 <div class="modal-actions wide"><button type="button" class="btn" data-action="close-modal">Отмена</button><button class="btn primary" type="submit">Сохранить</button></div></form>`);
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
 const item={...existing,id:existing?.id||uid(),walletId:w.id,toWalletId:editingType==='transfer'?dest.id:null,amountMinor:amount,toAmountMinor:editingType==='transfer'?amount:null,type:editingType,date,categoryId:editingType==='transfer'?null:String(data.get('category')||'')||null,note:cleanName(data.get('note')),labels:String(data.get('labels')||'').split(',').map(cleanName).filter(Boolean),createdAt:existing?.createdAt||new Date().toISOString()};
 await save('transactions',item);await loadData();closeModal();render();toast('Операция сохранена.');
}
async function submitBudget(form){
 const f=new FormData(form),old=state.budgets.find(b=>b.id===form.dataset.id),limitMinor=Math.round(Number(f.get('limit'))*100);
 if(!Number.isSafeInteger(limitMinor)||limitMinor<=0)return toast('Укажите правильный лимит.');
 await save('budgets',{id:old?.id||uid(),name:cleanName(f.get('name')),limitMinor,walletId:f.get('wallet'),categoryId:f.get('category')||null});
 await loadData();closeModal();render();toast('Бюджет сохранён.');
}
async function submitWallet(form){
 const f=new FormData(form),old=state.wallets.find(w=>w.id===form.dataset.id),initialBalanceMinor=Math.round(Number(f.get('initial'))*100);
 if(!Number.isSafeInteger(initialBalanceMinor))return toast('Некорректный начальный баланс.');
 const w={id:old?.id||uid(),name:cleanName(f.get('name')),currency:old?.currency||f.get('currency'),initialBalanceMinor};
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
 const data={version:1,exportedAt:new Date().toISOString(),wallets:state.wallets,categories:state.categories,transactions:state.transactions,budgets:state.budgets};
 download(JSON.stringify(data,null,2),`moy-koshelek-backup-${today()}.json`,'application/json;charset=utf-8');
}
function exportCSV(){
 const rows=[['Date','Type','Amount','Currency','Wallet','To wallet','Category','Note','Labels']];
 for(const t of [...state.transactions].sort(sortTx)){
   const w=state.wallets.find(x=>x.id===t.walletId);
   rows.push([t.date,t.type,((t.type==='expense'?-1:1)*t.amountMinor/100).toFixed(2),w?.currency||'RUB',w?.name||'',t.toWalletId?walletName(t.toWalletId):'',cat(t.categoryId)?.name||'',t.note,(t.labels||[]).join(', ')]);
 }
 download('\uFEFF'+rows.map(r=>r.map(csvEscape).join(';')).join('\r\n'),`moy-koshelek-${today()}.csv`,'text/csv;charset=utf-8');
}
async function restoreJSON(file){
 try {
  const data=JSON.parse(await file.text());const names=['wallets','categories','transactions','budgets'];
  if(data.version!==1||names.some(k=>!Array.isArray(data[k])))throw Error('Неверный формат резервной копии.');
  if(data.transactions.some(t=>!t.id||!t.walletId||!parseDate(t.date)||!Number.isSafeInteger(t.amountMinor)))throw Error('В копии найдены некорректные операции.');
  if(!confirm(`Заменить ВСЕ текущие данные из копии (${data.transactions.length} операций)? Сделайте резервную копию перед восстановлением.`))return;
  await replaceDatabase(data);await loadData();render();toast('База восстановлена.');
 } catch(e){toast('Ошибка восстановления: '+e.message);}
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
  if(!w){w={id:uid(),name:walletLabel,currency:fallbackWallet.currency,initialBalanceMinor:0};newWallets.push(w);wallets.push(w);}
  const name=cleanName(read('category'))||'Без категории';
  let c=categories.find(c=>c.type===type&&c.name.toLocaleLowerCase('ru')===name.toLocaleLowerCase('ru'));
  if(!c){c={id:uid(),name,type,color:type==='income'?'#38b88d':'#e36e7b'};newCategories.push(c);categories.push(c);}
  const note=read('note'),labels=read('labels').split(/[,;#]/).map(cleanName).filter(Boolean);
  const keyBase=[date,type,amountMinor,w.name.toLowerCase(),name.toLowerCase(),note,labels.join(',')].join('|');
  const nth=(duplicates.get(keyBase)||0)+1;duplicates.set(keyBase,nth);
  const sourceKey='csv:'+fingerprint(keyBase)+':'+nth;
  if(seen.has(sourceKey))continue;
  seen.add(sourceKey);
  newTx.push({id:uid(),date,type,amountMinor,walletId:w.id,toWalletId:null,categoryId:c.id,note,labels,sourceKey,createdAt:new Date().toISOString()});
 }
 try{
  await insertMany('wallets',newWallets);await insertMany('categories',newCategories);await insertMany('transactions',newTx);
  await loadData();closeModal();render();
  state.importRows=null;state.importHeaders=null;state.importMapping=null;
  toast(`Добавлено ${newTx.length}, пропущено ошибок ${skipped}, переводов ${transfers}. Повторы не добавлены.`);
  if(errors.length)alert('Примеры некорректных строк:\n'+errors.join('\n'));
 }catch(e){toast('Ошибка импорта: '+e.message);}
}

function bind(){
 document.addEventListener('click',async e=>{
  const nav=e.target.closest('[data-page]');if(nav){setPage(nav.dataset.page);return;}
  if(e.target.closest('#floating-add')){openQuickAdd();return;}
  const el=e.target.closest('[data-action]');if(!el)return;
  const a=el.dataset.action,id=el.dataset.id;
  if(a==='backdrop'&&e.target!==el)return;
  try{
   if(a==='backdrop'||a==='close-modal'){closeModal();return;}
   if(a==='show-transactions'){setPage('transactions');return;}
   if(a==='go-accounts'){setPage('accounts');return;}
   if(a==='quick-income'||a==='quick-expense'||a==='quick-transfer'){closeModal();openTransaction(null,a==='quick-income'?'income':a==='quick-transfer'?'transfer':'expense');return;}
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
  const f=e.target;if(!['tx-form','budget-form','wallet-form','category-form','import-form','ocr-expense-form'].includes(f.id))return;
  e.preventDefault();const btn=f.querySelector('button[type=submit]');if(btn)btn.disabled=true;
  try{if(f.id==='tx-form')await submitTransaction(f);if(f.id==='ocr-expense-form')await submitOcrExpense(f);if(f.id==='budget-form')await submitBudget(f);if(f.id==='wallet-form')await submitWallet(f);if(f.id==='category-form')await submitCategory(f);if(f.id==='import-form')await doCSVImport(f);}
  catch(err){console.error(err);toast('Ошибка: '+err.message);}
  finally{if(btn&&btn.isConnected)btn.disabled=false;}
 });
 document.addEventListener('change',async e=>{
  const el=e.target,id=el.id;
  if(id==='wallet-picker'){state.walletId=el.value;render();return;}
  if(id==='ocr-image'&&el.files?.[0]){const file=el.files[0];el.value='';await scanExpenseImage(file);return;}
  if(id==='period-picker'){state.period=el.value;render();return;}
  if(['tx-kind','tx-category','tx-from','tx-to','tx-min','tx-max'].includes(id)){
   state.txFilters[{'tx-kind':'kind','tx-category':'category','tx-from':'from','tx-to':'to','tx-min':'min','tx-max':'max'}[id]]=el.value;
   state.maxTx=100;$('#tx-list').innerHTML=transactionList();return;
  }
  if(id==='csv-file'&&el.files?.[0]){
   try{state.importRows=await readCSVFile(el.files[0]);state.importHeaders=state.importRows[0]||[];state.importMapping=guessMapping(state.importHeaders);openImportWizard();}
   catch(err){toast('Не удалось прочитать CSV: '+err.message);}
   el.value='';return;
  }
  if(id==='restore-file'&&el.files?.[0]){await restoreJSON(el.files[0]);el.value='';return;}
  if(id==='categories-seed-file'&&el.files?.[0]){
   try{
    const imported=JSON.parse(await el.files[0].text());
    if(!Array.isArray(imported)||imported.some(c=>typeof c.name!=='string'||!['income','expense'].includes(c.type))) throw Error('Неправильный список категорий.');
    const current=new Set(state.categories.map(c=>c.type+'|'+c.name.toLocaleLowerCase('ru')));
    const unique=[];
    for(const c of imported){
     const key=c.type+'|'+c.name.toLocaleLowerCase('ru');
     if(current.has(key))continue;
     current.add(key);
     unique.push({id:state.categories.some(old=>old.id===c.id)?uid():(c.id||uid()),name:cleanName(c.name),type:c.type,color:/^#[0-9a-fA-F]{6}$/.test(c.color)?c.color:'#39a888'});
    }
    await insertMany('categories',unique);await loadData();render();toast(`Добавлено категорий: ${unique.length}.`);
   }catch(err){toast('Не удалось загрузить категории: '+err.message);}
   el.value='';return;
  }
  if(el.name==='wallet' && el.closest('#tx-form')){
   const form=el.closest('form');const current=state.wallets.find(w=>w.id===el.value);
   const t=form.querySelector('[name=toWallet]');if(t)t.innerHTML='<option value="">Выберите</option>'+walletOptions('',w=>w.id!==current?.id&&w.currency===current?.currency);
  }
 });
 document.addEventListener('input',e=>{
  if(e.target.id==='tx-search'){state.txFilters.search=e.target.value;state.maxTx=100;$('#global-search').value=e.target.value;$('#tx-list').innerHTML=transactionList();}
  if(e.target.id==='global-search'){state.txFilters.search=e.target.value;state.maxTx=100;if(state.page!=='transactions')setPage('transactions');else $('#tx-list').innerHTML=transactionList();}
  if(e.target.id==='category-search'){$('#category-list').innerHTML=categoryList(e.target.value);}
 });
 document.addEventListener('keydown',e=>{if(e.key==='Escape')closeModal(); if((e.key==='Enter'||e.key===' ')&&e.target.matches('[data-action=select-month]')){e.preventDefault();e.target.click();}});
  $('#open-filters').addEventListener('click',()=>{setPage('transactions');document.getElementById('tx-search')?.focus();});
}
async function start(){
 try{await loadData();bind();render();if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js').catch(console.warn);}
 catch(e){console.error(e);$('#content').innerHTML=`<section class="panel">Ошибка открытия базы: ${esc(e.message)}. Проверьте, что сайт запущен по HTTPS или localhost и браузер разрешает IndexedDB.</section>`;}
}
start();
