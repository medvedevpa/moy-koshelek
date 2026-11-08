(() => {
  const toggle=document.querySelector('.nav-toggle');
  const links=document.querySelector('.nav-links');
  if(toggle && links){
    const close=()=>{links.classList.remove('is-open');toggle.setAttribute('aria-expanded','false');toggle.setAttribute('aria-label','Открыть меню')};
    toggle.addEventListener('click',()=>{const open=!links.classList.contains('is-open');links.classList.toggle('is-open',open);toggle.setAttribute('aria-expanded',String(open));toggle.setAttribute('aria-label',open?'Закрыть меню':'Открыть меню')});
    links.querySelectorAll('a').forEach(a=>a.addEventListener('click',close));
    document.addEventListener('keydown',e=>{if(e.key==='Escape')close()});
    document.addEventListener('click',e=>{if(!e.target.closest('.nav')&&links.classList.contains('is-open'))close()});
  }
  const filterButtons=document.querySelectorAll('[data-filter]');
  const cards=document.querySelectorAll('.product-card[data-category]');
  filterButtons.forEach(btn=>btn.addEventListener('click',()=>{
    const selected=btn.dataset.filter;
    filterButtons.forEach(b=>b.setAttribute('aria-pressed',String(b===btn)));
    cards.forEach(c=>{c.classList.toggle('is-hidden',selected!=='all' && !c.dataset.category.split(' ').includes(selected))});
  }));
  document.querySelectorAll('[data-track]').forEach(node=>node.addEventListener('click',()=>{
    const event={event:'contact_click',channel:node.dataset.track,product:node.dataset.product||'',page:location.pathname};
    window.dataLayer=window.dataLayer||[];window.dataLayer.push(event);
    if(typeof window.ym==='function' && typeof window.ART_METRIKA_ID==='number')window.ym(window.ART_METRIKA_ID,'reachGoal','contact_click',{channel:event.channel,product:event.product});
  }));
})();