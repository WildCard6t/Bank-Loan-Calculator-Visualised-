/* Settings panel, shared by index.html, tracker.html and desktop.html.
   Everything is saved in this browser under localStorage "loanSettings.v1"
   (plus "loanTheme" for Auto/Light/Dark and "loanDevice" for the layout).
   To add a setting: add a <section> in html() and handle it in wire(). */
(function(){
  const KS='loanSettings.v1',root=document.documentElement;
  const SCHEMES=[['indigo','Indigo','#4f46e5','#8f88ff'],['ocean','Ocean','#0e7490','#4fc3dc'],['forest','Forest','#2f7d4f','#5fcf8e'],['sunset','Sunset','#c2410c','#ff9466'],['graphite','Graphite','#1a1c29','#eceef5']];
  const COUNTRIES=[['AU','🇦🇺 Australia','$ Australian dollar'],['NZ','🇳🇿 New Zealand','$ New Zealand dollar'],['US','🇺🇸 United States','$ US dollar'],['CA','🇨🇦 Canada','$ Canadian dollar'],['UK','🇬🇧 United Kingdom','£ Pound sterling']];
  const NOTES={
    AU:'Australian home loans are usually variable rate, paid monthly, fortnightly or weekly, and often come with an offset account. Banks work interest out daily and charge it monthly.',
    NZ:'New Zealand loans are often fixed for 1 to 5 years and then re-fixed, paid weekly, fortnightly or monthly. Offset accounts exist at some banks.',
    US:'US mortgages are usually 30-year fixed rate, paid monthly, with interest worked out monthly, which matches this calculator exactly for monthly payments. Offset accounts are rare. Property tax, insurance and PMI are often added to the bank’s payment (escrow); they are not included here.',
    CA:'Canadian mortgages are usually fixed for 5 years within a 25-year loan. By law fixed-rate interest is compounded half-yearly, so a bank’s payment will differ a little from this calculator.',
    UK:'UK mortgages are usually fixed for 2 to 5 years within a 25-year loan, paid monthly. Offset mortgages exist but are less common.'
  };
  const get=()=>{try{return JSON.parse(localStorage.getItem(KS))||{}}catch(e){return {}}};
  const put=o=>{try{localStorage.setItem(KS,JSON.stringify(o))}catch(e){}};
  const frames=msg=>document.querySelectorAll('iframe').forEach(f=>{try{f.contentWindow.postMessage(msg,'*')}catch(e){}});
  const dark=()=>root.dataset.theme==='dark'||(root.dataset.theme!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);
  let ov=null,lastFocus=null;

  function html(){
    const hasLayout=!!document.getElementById('devSw');
    return '<div class="set" role="dialog" aria-modal="true" aria-labelledby="setT">'+
      '<header><h2 id="setT">Settings</h2><button type="button" class="set-x" aria-label="Close settings">✕</button></header>'+
      '<section><h3>Appearance</h3>'+
        '<div class="set-lab">Mode</div>'+
        '<div class="set-seg" data-k="mode"><button type="button" data-v="auto">🌗 Auto</button><button type="button" data-v="light">☀ Light</button><button type="button" data-v="dark">☾ Dark</button></div>'+
        '<p class="set-hint">Auto follows your phone or computer.</p>'+
        '<div class="set-lab">Colour scheme</div>'+
        '<div class="set-sw" data-k="scheme">'+SCHEMES.map(([v,n])=>'<button type="button" data-v="'+v+'" aria-label="'+n+' colour scheme"><i></i>'+n+'</button>').join('')+'</div>'+
        '<p class="set-hint">Changes buttons and highlights. The loan curves keep their own colours, so the graph always reads the same.</p>'+
      '</section>'+
      '<section><h3>Country and currency</h3>'+
        '<div class="set-seg set-cty" data-k="country" style="flex-wrap:wrap">'+COUNTRIES.map(([v,n])=>'<button type="button" data-v="'+v+'" style="flex:1 1 30%">'+n+'</button>').join('')+'</div>'+
        '<p class="set-hint" id="setCur"></p>'+
        '<p class="set-hint" id="setNote"></p>'+
      '</section>'+
      '<section><h3>Your data</h3>'+
        '<p class="set-hint">Everything you enter is saved automatically on this device. No account, nothing sent anywhere. Make a backup file now and then so it can\u2019t be lost, for example if the browser\u2019s data is cleared or you change phone.</p>'+
        '<p class="set-stat" id="setBk"></p>'+
        '<div class="set-row"><button type="button" class="set-btn pri" data-act="export">⬇ Save backup file</button><button type="button" class="set-btn" data-act="import">⬆ Load backup file</button></div>'+
        '<input type="file" id="setFile" accept=".json,application/json" hidden>'+
        '<div class="set-confirm" id="setImp" hidden></div>'+
        '<button type="button" class="set-btn" data-act="undo" id="setUndo" hidden>↶ Undo the last load or reset</button>'+
        '<p class="set-hint" id="setPersist"></p>'+
      '</section>'+
      (hasLayout?'<section><h3>Layout</h3>'+
        '<div class="set-seg" data-k="device"><button type="button" data-v="phone">📱 Phone</button><button type="button" data-v="desktop">🖥️ Computer</button></div>'+
        '<a class="set-link" href="desktop.html">⧉ Combined view: graph and Tracker side by side</a>'+
      '</section>':'')+
      '<section><h3>Reset</h3><div class="set-row"><button type="button" class="set-reset">Reset settings</button><button type="button" class="set-reset" data-act="wipe">Erase all my data</button></div>'+
        '<p class="set-hint" id="setWipeH">Reset settings only changes how things look and the country. Erase all my data removes every loan and Tracker log from this device (you get one chance to undo).</p></section>'+
      '<footer class="set-hint">Settings are saved on this device and shared by every page of the app.</footer>'+
    '</div>';
  }

  function sync(){
    if(!ov)return;
    const s=get(),mode=window.loanTheme?loanTheme.get():'auto',scheme=s.scheme||'indigo',cty=window.loanRegion?loanRegion.country:'AU';
    const mark=(k,v)=>ov.querySelectorAll('[data-k="'+k+'"] button').forEach(b=>{const on=b.dataset.v===v;b.classList.toggle('on',on);b.setAttribute('aria-pressed',on)});
    mark('mode',mode);mark('scheme',scheme);mark('country',s.country||cty);mark('device',root.dataset.device);
    const d=dark();ov.querySelectorAll('[data-k="scheme"] button').forEach(b=>{const c=SCHEMES.find(x=>x[0]===b.dataset.v);b.querySelector('i').style.background=d?c[3]:c[2]});
    const c=COUNTRIES.find(x=>x[0]===(s.country||cty))||COUNTRIES[0];
    const ex=c[0]==='US'?'Jul 20, 2026':'20 Jul 2026';
    ov.querySelector('#setCur').textContent='Money shows as '+c[2]+'. Dates show like '+ex+'. The loan maths is the same everywhere.';
    ov.querySelector('#setNote').textContent=NOTES[c[0]];
    const bk=ov.querySelector('#setBk');if(!bk.classList.contains('flash')){const lb=day(s.lastBackup),t=trackerInfo((()=>{try{return JSON.parse(raw('loanTracker.v1'))}catch(e){return null}})());
      bk.textContent=(t?'On this device: '+t.n+' Tracker loan'+(t.n===1?'':'s')+'. ':'')+(lb?'Last backup: '+niceDate(lb)+' ('+ago(lb)+').':'No backup saved yet.');bk.classList.toggle('warn',due())}
    ov.querySelector('#setUndo').hidden=!raw(UNDO);
  }

  function wire(){
    ov.addEventListener('click',e=>{
      if(e.target===ov||e.target.closest('.set-x')){close();return}
      const b=e.target.closest('[data-k] button');
      if(b){const k=b.closest('[data-k]').dataset.k,v=b.dataset.v;
        if(k==='mode'){loanTheme.set(v);frames({loanSettings:1})}
        else if(k==='scheme'){loanTheme.setScheme(v);frames({loanSettings:1})}
        else if(k==='country'){const s=get();if((s.country||'AU')!==v){s.country=v;put(s);frames({loan:'reloadAll'});sessionStorage.setItem('loanSettingsOpen','1');location.reload();return}}
        else if(k==='device'){const sw=document.getElementById('devSw');if(sw&&root.dataset.device!==v)sw.click()}
        sync();return}
      const act=e.target.closest('[data-act]');
      if(act){const a=act.dataset.act;
        if(a==='export')exportFile();
        else if(a==='import')ov.querySelector('#setFile').click();
        else if(a==='doImport')doImport();
        else if(a==='cancelImport'){pending=null;const bx=ov.querySelector('#setImp');bx.hidden=true;bx.innerHTML=''}
        else if(a==='undo')undo();
        else if(a==='wipe')wipe(act);
        return}
      if(e.target.closest('.set-reset')){
        const s=get(),cty=s.country;delete s.scheme;delete s.country;put(s);
        loanTheme.setScheme('indigo');loanTheme.set('auto');frames({loanSettings:1});
        if(cty&&cty!=='AU'){frames({loan:'reloadAll'});sessionStorage.setItem('loanSettingsOpen','1');location.reload();return}
        sync()}
    });
    ov.querySelector('#setFile').addEventListener('change',e=>{const f=e.target.files[0];if(f)readFile(f);e.target.value=''});
    ov.addEventListener('keydown',e=>{
      if(e.key==='Escape'){close();return}
      if(e.key==='Tab'){const f=[...ov.querySelectorAll('button,a')].filter(x=>x.offsetParent),a=f[0],z=f[f.length-1];
        if(e.shiftKey&&document.activeElement===a){z.focus();e.preventDefault()}else if(!e.shiftKey&&document.activeElement===z){a.focus();e.preventDefault()}}
    });
    window.addEventListener('themechange',sync);
    window.addEventListener('devicechange',sync);
  }

  /* ---- backups: one .json file holding every saved key ---- */
  const KEYS=['loanTracker.v1','loanGraph.v2','loanSettings.v1','loanTheme','loanDevice'],UNDO='loanBackup.undo';
  const raw=k=>{try{return localStorage.getItem(k)}catch(e){return null}};
  const day=d=>{const x=new Date(d);return isNaN(x)?null:x};
  const ago=d=>{const n=Math.floor((Date.now()-d)/864e5);return n<=0?'today':n===1?'yesterday':n+' days ago'};
  const niceDate=d=>d.toLocaleDateString(window.loanRegion?loanRegion.locale:'en-AU',{day:'numeric',month:'short',year:'numeric'});
  function snapshot(){const data={};KEYS.forEach(k=>{const v=raw(k);if(v==null)return;try{data[k]=JSON.parse(v)}catch(e){data[k]=v}});return data}
  function restore(data){KEYS.forEach(k=>{try{localStorage.removeItem(k)}catch(e){}});Object.keys(data).forEach(k=>{if(!KEYS.includes(k))return;const v=data[k];try{localStorage.setItem(k,typeof v==='string'?v:JSON.stringify(v))}catch(e){}})}
  function trackerInfo(t){if(!t||!t.profiles)return null;const ps=Object.values(t.profiles);return {n:ps.length,names:ps.map(p=>p.name||'Unnamed').slice(0,4),logs:ps.reduce((a,p)=>a+((p.log||p.entries||[]).length||0),0)}}
  function markBackup(){const s=get();s.lastBackup=new Date().toISOString();put(s);sync();badge()}
  function due(){
    if(!raw('loanTracker.v1'))return false;
    const s=get();if(!s.firstSeen){s.firstSeen=new Date().toISOString();put(s)}
    const since=day(s.lastBackup)||day(s.firstSeen);return since&&Date.now()-since>30*864e5}
  function badge(){const b=document.getElementById('setSw');if(!b)return;const d=due();b.classList.toggle('due',d);b.title=d?'Time to save a backup of your loan data':'Colours, country, layout and backups'}
  function exportFile(){
    const now=new Date(),y=now.getFullYear(),m=String(now.getMonth()+1).padStart(2,'0'),dd=String(now.getDate()).padStart(2,'0');
    const body={app:'Bank Loan Visualised',kind:'backup',version:1,saved:now.toISOString(),data:snapshot()};
    const blob=new Blob([JSON.stringify(body,null,2)],{type:'application/json'}),a=document.createElement('a');
    a.href=URL.createObjectURL(blob);a.download='bank-loan-backup_'+y+'-'+m+'-'+dd+'.json';document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(a.href),5000);markBackup();
    msg('Backup saved. On iPhone it goes to Files › Downloads; on a computer, your Downloads folder.')}
  function msg(t){const p=ov&&ov.querySelector('#setBk');if(p){p.textContent=t;p.classList.add('flash');setTimeout(()=>{p.classList.remove('flash');sync()},4500)}}
  let pending=null;
  async function readFile(f){
    const box=ov.querySelector('#setImp');box.hidden=false;
    try{
      const d=JSON.parse(await f.text());
      if(d&&d.kind==='backup'&&d.data)pending={data:d.data,saved:day(d.saved)};
      else if(d&&d.profiles)pending={data:{'loanTracker.v1':{v:1,cur:d.cur in d.profiles?d.cur:Object.keys(d.profiles)[0],profiles:d.profiles}},saved:null,trackerOnly:true};
      else throw 0;
      const t=trackerInfo(pending.data['loanTracker.v1']);
      box.innerHTML='<b>Load this backup?</b><span>'+(pending.saved?'Saved '+niceDate(pending.saved)+' ('+ago(pending.saved)+'). ':'')+
        (t?t.n+' loan profile'+(t.n===1?'':'s')+': '+t.names.map(esc).join(', ')+(t.n>4?'…':'')+'. ':'No Tracker loans. ')+
        (pending.trackerOnly?'This is a Tracker export, so only your Tracker loans are replaced.':'It replaces the loans and settings on this device.')+
        ' You can undo straight after.</span><div class="set-row"><button type="button" class="set-btn pri" data-act="doImport">Yes, load it</button><button type="button" class="set-btn" data-act="cancelImport">Cancel</button></div>';
      box.querySelector('[data-act=doImport]').focus();
    }catch(e){pending=null;box.innerHTML='<b>That file can’t be loaded.</b><span>Choose a backup made with “Save backup file”, or a Tracker export.</span><div class="set-row"><button type="button" class="set-btn" data-act="cancelImport">OK</button></div>'}
  }
  const esc=t=>String(t).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  function keepUndo(){try{localStorage.setItem(UNDO,JSON.stringify({at:new Date().toISOString(),data:snapshot()}))}catch(e){}}
  function reloadAll(){frames({loan:'reloadAll'});try{sessionStorage.setItem('loanSettingsOpen','1')}catch(e){};location.reload()}
  function doImport(){if(!pending)return;keepUndo();
    if(pending.trackerOnly){try{localStorage.setItem('loanTracker.v1',JSON.stringify(pending.data['loanTracker.v1']))}catch(e){}}
    else{const keep=get();restore(pending.data);const s=get();s.lastBackup=keep.lastBackup||s.lastBackup;s.firstSeen=keep.firstSeen||s.firstSeen;put(s)}
    pending=null;reloadAll()}
  function undo(){let u=null;try{u=JSON.parse(localStorage.getItem(UNDO))}catch(e){}if(!u)return;restore(u.data);try{localStorage.removeItem(UNDO)}catch(e){};reloadAll()}
  let wipeArm=0;
  function wipe(btn){
    if(Date.now()-wipeArm>5000){wipeArm=Date.now();btn.textContent='Tap again to erase everything';btn.classList.add('armed');setTimeout(()=>{if(btn.isConnected){btn.textContent='Erase all my data';btn.classList.remove('armed')}},5000);return}
    keepUndo();const s=get();restore({});put({lastBackup:s.lastBackup});reloadAll()}
  async function persist(){
    const p=ov&&ov.querySelector('#setPersist');if(!navigator.storage||!navigator.storage.persist){if(p)p.textContent='';return}
    let ok=false;try{ok=await navigator.storage.persisted()||await navigator.storage.persist()}catch(e){}
    if(p)p.textContent=ok?'✓ This browser has agreed to keep your data and not clear it to save space.':'Tip: on iPhone, Add to Home Screen helps Safari keep your data. A backup file is still the safest copy.'}

  function open(){
    if(!ov){ov=document.createElement('div');ov.className='set-ov';ov.hidden=true;ov.innerHTML=html();document.body.appendChild(ov);wire()}
    lastFocus=document.activeElement;sync();persist();ov.hidden=false;document.body.style.overflow='hidden';
    ov.querySelector('.set-x').focus();
  }
  function close(){if(!ov||ov.hidden)return;ov.hidden=true;document.body.style.overflow='';if(lastFocus&&lastFocus.focus)lastFocus.focus()}
  window.loanSettings={open,close,get,markBackup};

  /* currency symbol inside the money boxes */
  function money(){const sym=window.loanRegion?loanRegion.sym:'$';document.querySelectorAll('.unit.pre > i').forEach(i=>{if(i.textContent==='$'||i.textContent==='£')i.textContent=sym})}
  function boot(){money();badge();window.addEventListener('pageshow',badge);try{if(sessionStorage.getItem('loanSettingsOpen')){sessionStorage.removeItem('loanSettingsOpen');open()}}catch(e){}}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();
