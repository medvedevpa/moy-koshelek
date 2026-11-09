// Free on-device OCR. Library and language files are fetched on first use.
let libPromise;
let workerPromise;
export async function recognizeImage(file, onProgress=()=>{}) {
  if (!file || !file.type.startsWith('image/')) throw new Error('Выберите изображение PNG, JPG или WEBP.');
  if (file.size > 15 * 1024 * 1024) throw new Error('Изображение слишком большое (максимум 15 МБ).');
  if (!libPromise) {
    libPromise = new Promise((resolve,reject)=>{
      if (window.Tesseract) return resolve(window.Tesseract);
      const script=document.createElement('script');
      script.src='https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
      script.onload=()=>window.Tesseract?resolve(window.Tesseract):reject(Error('OCR не загрузился'));
      script.onerror=()=>reject(Error('Не удалось загрузить OCR: нужен интернет.'));
      document.head.appendChild(script);
    }).catch(e=>{libPromise=null;throw e;});
  }
  const Tesseract=await libPromise;
  if(!workerPromise){
    workerPromise=Tesseract.createWorker('rus+eng',1,{
      logger:m=>{if(m.status)onProgress(`${m.status}${m.progress!=null?' · '+Math.round(m.progress*100)+'%':''}`);}
    }).catch(e=>{workerPromise=null;throw e;});
  }
  const worker=await workerPromise;
  onProgress('Распознаём текст…');
  const result=await worker.recognize(file);
  let text=result.data.text||'';
  // T-Bank sometimes puts cashback in a small dark pill under the large debit.
  // Whole-screen OCR can miss white letters on that pill. Try one focused pass.
  if (/покупка по карте|основная дебетовая|т[-\s]?банк/i.test(text) &&
      !parseScreenshot(text, '').cashback) {
    try {
      const pill=await findDarkCashbackPill(file);
      if (pill) {
        onProgress('Проверяем плашку кешбэка…');
        const badgeText=(await worker.recognize(pill)).data.text||'';
        if (/\+\s*\d/.test(badgeText))
          text+='\nКЕШБЭК_ПЛАШКА '+badgeText.replace(/\s+/g,' ').trim();
      }
    } catch (e) { console.info('Не удалось уточнить плашку кешбэка', e); }
  }
  return text;
}

// Recognize a dark rounded cashback badge below the large transaction amount.
// It is a best-effort supplement for T-Bank's UI, not a universal bank parser.
async function findDarkCashbackPill(file) {
  if (typeof createImageBitmap !== 'function') return null;
  const bitmap=await createImageBitmap(file);
  try {
    const scale=Math.min(1,900/bitmap.width),w=Math.round(bitmap.width*scale),h=Math.round(bitmap.height*scale);
    const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    if(!ctx)return null;
    ctx.drawImage(bitmap,0,0,w,h);
    const data=ctx.getImageData(0,0,w,h).data;
    const dark=(x,y)=>{
      const k=(y*w+x)*4;
      return (data[k]*3+data[k+1]*6+data[k+2])/10 < 105;
    };
    let found=null;
    const xmin=Math.round(w*.25),xmax=Math.round(w*.75);
    for(let y=Math.round(h*.28);y<Math.round(h*.57);y+=2){
      let run=0,start=xmin;
      for(let x=xmin;x<=xmax;x+=2){
        if(x<xmax&&dark(x,y)){if(run===0)start=x;run+=2;}
        else {
          const center=(start+x)/2;
          if(run>w*.105&&run<w*.38&&Math.abs(center-w/2)<w*.14){
            // The pill is a solid dark horizontal shape, unlike large spaced digits.
            const candidate={x0:start,x1:x,y,width:run};
            if(!found||candidate.width>found.width)found=candidate;
          }
          run=0;
        }
      }
    }
    if(!found)return null;
    const xc=Math.round(found.x0+(found.x1-found.x0)*.08);
    let y0=found.y,y1=found.y;
    while(y0>h*.26 && dark(xc,y0-1))y0--;
    while(y1<h*.6 && dark(xc,y1+1))y1++;
    if(y1-y0<h*.012 || y1-y0>h*.07)return null;
    const x0=Math.max(0,found.x0+5),x1=Math.min(w,found.x1-5);
    if(x1-x0<40)return null;
    const innerTop=y0+Math.max(3,Math.round((y1-y0)*.12));
    const innerBottom=y1-Math.max(3,Math.round((y1-y0)*.12));
    const factor=3,pad=18;
    const out=document.createElement('canvas');out.width=(x1-x0)*factor+pad*2;
    out.height=(innerBottom-innerTop)*factor+pad*2;
    const oc=out.getContext('2d');
    oc.fillStyle='#fff';oc.fillRect(0,0,out.width,out.height);
    const temp=oc.createImageData(x1-x0,innerBottom-innerTop);
    for(let y=innerTop;y<innerBottom;y++)for(let x=x0;x<x1;x++){
      const k=(y*w+x)*4,t=((y-innerTop)*(x1-x0)+(x-x0))*4;
      const gray=(data[k]+data[k+1]+data[k+2])/3;
      // Inside the pill, pale glyphs become dark and the pill becomes white.
      const v=gray>145?0:255;
      temp.data[t]=temp.data[t+1]=temp.data[t+2]=v;temp.data[t+3]=255;
    }
    const tile=document.createElement('canvas');tile.width=x1-x0;tile.height=innerBottom-innerTop;
    tile.getContext('2d').putImageData(temp,0,0);
    oc.imageSmoothingEnabled=false;
    oc.drawImage(tile,pad,pad,tile.width*factor,tile.height*factor);
    return out;
  } finally { bitmap.close(); }
}

// Parses one card payment screenshot. Never auto-saves OCR guesses.
export function parseScreenshot(text, fallbackDate) {
  const lines=String(text).split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  const full=lines.join(' ');
  let date=fallbackDate||'';
  const numericDate=full.match(/\b(\d{1,2})[.\/-](\d{1,2})[.\/-](20\d{2})\b/);
  if(numericDate){
    const dd=Number(numericDate[1]),mm=Number(numericDate[2]),yy=Number(numericDate[3]);
    const chk=new Date(Date.UTC(yy,mm-1,dd));
    if(chk.getUTCFullYear()===yy&&chk.getUTCMonth()===mm-1&&chk.getUTCDate()===dd)
      date=`${yy}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
  } else {
    // Bank details often show "4 ноября • 13:33", without the year.
    const months=['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
    const ruDate=full.toLocaleLowerCase('ru-RU').match(new RegExp('(?:^|[^0-9])([0-3]?\\d)\\s+('+months.join('|')+')(?=[^а-яё]|$)','i'));
    if(ruDate && /^20\d\d-\d\d-\d\d$/.test(fallbackDate||'')){
      const dd=Number(ruDate[1]),mm=months.indexOf(ruDate[2])+1;
      let yy=Number(fallbackDate.slice(0,4));
      const candidate=new Date(Date.UTC(yy,mm-1,dd));
      if(candidate.toISOString().slice(0,10)>fallbackDate)yy--;
      const check=new Date(Date.UTC(yy,mm-1,dd));
      if(check.getUTCDate()===dd&&check.getUTCMonth()===mm-1)
        date=`${yy}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
    }
  }
  const amounts=[];
  // The last symbol is also often recognized as Latin P or Cyrillic Р by OCR.
  const moneyRe=/([+＋−–—-]?\s*(?:\d{1,3}(?:[ \u00a0\u202f]\d{3})+|\d+)(?:[.,]\d{1,2})?)\s*(₽|руб\.?|RUB|[РрPp](?![a-zа-я]))?/gi;
  for(const [index,line] of lines.entries()){
    // Ignore isolated dates: their separators must not look like a withdrawal.
    if (/^\s*20\d{2}[-./]\d{1,2}[-./]\d{1,2}\s*$/.test(line) || /^\s*\d{1,2}[-./]\d{1,2}[-./]20\d{2}\s*$/.test(line))continue;
    const looksFinancial=/₽|руб\.?|RUB|[+＋−–—-]\s*\d|\d\s*[РрPp](?![a-zа-я])|кешб[еэ]к|cashback|сумма|оплата|списани/i.test(line);
    if(!looksFinancial)continue;
    for(const match of line.matchAll(moneyRe)){
      const raw=match[1].replace(/[\s\u00a0\u202f]/g,'').replace(',','.').replace(/[＋]/g,'+').replace(/[−–—]/g,'-');
      const value=Number(raw);
      if(!Number.isFinite(value)||Math.abs(value)<.01||Math.abs(value)>1e9)continue;
      if(!match[2] && !/^[+\-]/.test(raw) && !/кешб[еэ]к|cashback|сумма|списани/i.test(line))continue;
      if(!match[2] && /%/.test(line))continue;
      let score=(match[2]?4:0)+(raw.startsWith('-')?12:0)+(/списани|оплат|сумма|итого|покуп/i.test(line)?2:0);
      if(/баланс|остаток|доступно|в месяц|рассроч|оформление|вознаграждени|кредит/i.test(line))score-=18;
      amounts.push({amount:Math.abs(value),signed:value,score,index,line,explicit:/кешб[еэ]к|cashback|бонус|возврат|КЕШБЭК_ПЛАШКА/i.test(line),plus:raw.startsWith('+')});
    }
  }
  const debits=amounts.filter(a=>a.signed<0);
  const grossCandidate=(debits.length?debits:amounts.filter(a=>!a.explicit&&!a.plus)).sort((a,b)=>b.score-a.score||a.index-b.index)[0];
  const amount=grossCandidate?.amount||null;
  if (!grossCandidate) return {date,amount:null,cashback:0,netAmount:null,merchant:'',found:amounts.length,raw:lines.join('\n')};
  const cashbackCandidates=amounts.filter(a=>a!==grossCandidate&&a.amount<=amount&&a.signed>=0&&(
    a.explicit || (a.plus && a.index>=grossCandidate.index && a.index<=grossCandidate.index+4 && !/в месяц|рассроч/i.test(a.line))
  ));
  cashbackCandidates.sort((a,b)=>(Number(b.explicit)-Number(a.explicit))||Math.abs(a.index-grossCandidate.index)-Math.abs(b.index-grossCandidate.index));
  const cashback=cashbackCandidates[0]?.amount||0;
  const merchant=lines.find(line=>line.length>=3&&line.length<=80&&/[a-zа-яё]/i.test(line)&&
    !/(баланс|остаток|доступно|списани|оплат|покуп|сумма|перевод|карт|сч[её]т|руб|детали|чек|операци|плат[её]ж|кешб|₽|\bRUB\b|^\d|т[-\s]?банк|[+−–—-]\s*\d)/i.test(line))||'';
  return {date,amount,cashback,netAmount:amount==null?null:Math.max(0,Math.round((amount-cashback)*100)/100),merchant,found:amounts.length,raw:lines.join('\n')};
}
