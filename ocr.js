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
  return result.data.text||'';
}

// A modest heuristic for a single bank transaction screenshot, never auto-saves.
export function parseScreenshot(text, fallbackDate) {
  const lines=String(text).split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  const full=lines.join(' ');
  let date=fallbackDate;
  const d=full.match(/\b(\d{1,2})[.\/-](\d{1,2})[.\/-](20\d{2})\b/);
  if(d){const dd=Number(d[1]),mm=Number(d[2]),yy=Number(d[3]);
    const chk=new Date(Date.UTC(yy,mm-1,dd));
    if(chk.getUTCFullYear()===yy&&chk.getUTCMonth()===mm-1&&chk.getUTCDate()===dd)
      date=`${yy}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
  }
  // Prefer amounts next to currency symbols or 'списание/оплата' labels.
  const amounts=[];
  const candidateRe=/(?<!\d)([−-]?\s*\d{1,3}(?:[ \u00a0\u202f]\d{3})*(?:[.,]\d{2})|[−-]?\s*\d+(?:[.,]\d{2})?)(?!\d)/g;
  for(const [index,line] of lines.entries()){
    const looksFinancial=/(₽|руб\.?|\bRUB\b|списани|оплат|покуп|сумма|плат[её]ж|перевод|расход|итого|−|-\s*\d)/i.test(line);
    if(!looksFinancial)continue;
    for(const m of line.matchAll(candidateRe)){
      const number=m[1].replace(/[\s\u00a0\u202f]/g,'').replace(',','.').replace('−','-');
      const value=Number(number);
      if(!Number.isFinite(value)||Math.abs(value)<0.01||Math.abs(value)>1e9)continue;
      if(/^(20\d{2})$/.test(number))continue;
      let score=(/[₽]|\bRUB\b|руб/i.test(line)?4:0)+(m[1].trim().startsWith('-')||m[1].trim().startsWith('−')?3:0)+(/списани|оплат|сумма|итого|покуп/i.test(line)?2:0);
      if(/баланс|остаток|доступно/i.test(line))score-=8;
      amounts.push({amount:Math.abs(value),score,index});
    }
  }
  amounts.sort((a,b)=>b.score-a.score||a.index-b.index);
  // Pick a probable merchant name; OCR may fail, so always show editable note.
  const merchant=lines.find(line=>line.length>=3&&line.length<=80&&/[a-zа-яё]/i.test(line)&&
    !/(баланс|остаток|доступно|списани|оплат|покуп|сумма|перевод|карт|сч[её]т|руб|детали|чек|операци|плат[её]ж|₽|\bRUB\b|^\d)/i.test(line))||'';
  return {date,amount:amounts[0]?.amount||null,merchant,found:amounts.length,raw:lines.join('\n')};
}
