const DB_NAME = "veltrix-live-tick-archives";
const DB_VERSION = 2;
const STORE = "datasets";
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TICKS = 250_000;
const SYMBOLS = new Set(["XAUUSD", "XAGUSD"]);

export function parseTimestamp(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== "string") return NaN;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/i.exec(value);
  if (!match) return NaN;
  const [, y, m, d, h, min, sec, , zone] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  const hour = Number(h), minute = Number(min), second = Number(sec);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > days || hour > 23 || minute > 59 || second > 59) return NaN;
  if (zone.toUpperCase() !== "Z") {
    const [oh, om] = zone.slice(1).split(":").map(Number);
    if (oh > 14 || om > 59 || (oh === 14 && om !== 0)) return NaN;
  }
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) ? parsed : NaN;
}

function csvRows(text) {
  const rows = []; let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') {
      if (field.length) throw new Error("Malformed CSV quoting.");
      quoted = true;
    } else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some(v => v.length)) rows.push(row);
      row = [];
    } else field += c;
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field.");
  row.push(field); if (row.some(v => v.length)) rows.push(row);
  return rows;
}

export function validateArchive({ metadata, quotes } = {}) {
  const errors = [];
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return { ok:false, errors:["Dataset metadata is required."] };
  const symbol = String(metadata.symbol || "").toUpperCase();
  const provider = typeof metadata.provider === "string" ? metadata.provider.trim() : "";
  const sourceReference = typeof metadata.sourceReference === "string" ? metadata.sourceReference.trim() : "";
  if (!SYMBOLS.has(symbol)) errors.push("Choose XAUUSD or XAGUSD.");
  if (!provider || provider.length > 120) errors.push("Provider name is required (maximum 120 characters).");
  if (!sourceReference || sourceReference.length > 500) errors.push("Source reference is required (maximum 500 characters).");
  if (metadata.dataKind !== "tick") errors.push("Tick data is required; OHLC candles are not accepted.");
  if (!Array.isArray(quotes) || quotes.length < 10) errors.push("At least ten tick quotes are required to create two or more ticks in each chronological partition.");
  if (Array.isArray(quotes) && quotes.length > MAX_TICKS) errors.push("Browser import is limited to 250,000 ticks per archive.");
  if (errors.length) return { ok:false, errors };

  const normalized = [], intervals = [];
  let previous = -Infinity;
  for (let i = 0; i < quotes.length; i++) {
    const q = quotes[i];
    const timestamp = parseTimestamp(q?.timestamp);
    const bid = q?.bid, ask = q?.ask;
    const tickSymbol = String(q?.symbol || symbol).toUpperCase();
    if (tickSymbol !== symbol) errors.push(`Symbol mismatch at tick ${i + 1}.`);
    if (!Number.isSafeInteger(timestamp)) errors.push(`Invalid timezone-explicit timestamp at tick ${i + 1}.`);
    else if (timestamp <= previous) errors.push(`Duplicate or out-of-order timestamp at tick ${i + 1}.`);
    if (typeof bid !== "number" || !Number.isFinite(bid) || bid <= 0 ||
        typeof ask !== "number" || !Number.isFinite(ask) || ask <= bid) errors.push(`Invalid Bid/Ask at tick ${i + 1}.`);
    if (errors.length) break;
    if (normalized.length) intervals.push(timestamp - previous);
    normalized.push({symbol, provider, dataKind:"tick", timestamp:new Date(timestamp).toISOString(), timestampMs:timestamp, bid, ask, spread:ask-bid, mid:(ask+bid)/2});
    previous = timestamp;
  }
  if (errors.length) return {ok:false,errors:errors.slice(0,20)};
  const sorted = [...intervals].sort((a,b)=>a-b);
  const percentile = p => {
    if (!sorted.length) return null;
    const at=(sorted.length-1)*p, lo=Math.floor(at), hi=Math.ceil(at);
    return sorted[lo]+(sorted[hi]-sorted[lo])*(at-lo);
  };
  const startMs=normalized[0].timestampMs, endMs=normalized.at(-1).timestampMs;
  const split1=Math.floor(normalized.length*.6), split2=Math.floor(normalized.length*.8);
  const partition = (from,to) => ({tickCount:to-from,startAt:normalized[from]?.timestamp||null,endAt:normalized[to-1]?.timestamp||null});
  return {ok:true,manifest:{
    symbol,provider,sourceReference,dataKind:"tick",tickCount:normalized.length,
    startAt:normalized[0].timestamp,endAt:normalized.at(-1).timestamp,durationMs:endMs-startMs,
    medianIntervalMs:percentile(.5),p95IntervalMs:percentile(.95),
    maxGapMs:intervals.length?intervals.reduce((max,value)=>Math.max(max,value),0):null,chronological:true,
    quoteIntegrityValidated:true,splitMethod:"chronological_60_20_20",
    partitions:{train:partition(0,split1),validation:partition(split1,split2),heldOutTest:partition(split2,normalized.length)},
    importedAt:new Date().toISOString()
  },quotes:normalized};
}

export function parseArchiveFile({name,text,metadata}) {
  if (typeof text !== "string") return {ok:false,errors:["File content is unreadable."]};
  if (name.toLowerCase().endsWith(".csv")) {
    let rows;
    try { rows=csvRows(text); } catch(e) { return {ok:false,errors:[e.message]}; }
    if (rows.length<3) return {ok:false,errors:["CSV requires a header and at least two tick rows."]};
    const headers=rows[0].map(v=>v.trim().replace(/^\uFEFF/,"").toLowerCase());
    if (new Set(headers).size!==headers.length) return {ok:false,errors:["Duplicate CSV column names."]};
    const ti=headers.indexOf("timestamp"), bi=headers.indexOf("bid"), ai=headers.indexOf("ask"), si=headers.indexOf("symbol");
    if ([ti,bi,ai].some(i=>i<0)) return {ok:false,errors:["CSV must contain timestamp,bid,ask columns."]};
    const quotes=[];
    for(let i=1;i<rows.length;i++){
      if(rows[i].length!==headers.length) return {ok:false,errors:[`CSV column count mismatch at row ${i+1}.`]};
      const b=rows[i][bi].trim(), a=rows[i][ai].trim();
      if(!/^\d+(?:\.\d+)?$/.test(b)||!/^\d+(?:\.\d+)?$/.test(a)) return {ok:false,errors:[`Prices must be plain decimal values at row ${i+1}.`]};
      quotes.push({timestamp:/^\d+$/.test(rows[i][ti].trim())?Number(rows[i][ti].trim()):rows[i][ti].trim(),bid:Number(b),ask:Number(a),symbol:si>=0?rows[i][si].trim():metadata.symbol});
    }
    return validateArchive({metadata:{...metadata,dataKind:"tick"},quotes});
  }
  try {
    const parsed=JSON.parse(text);
    return validateArchive({metadata:parsed.metadata||metadata,quotes:parsed.quotes});
  } catch(e) { return {ok:false,errors:["Invalid JSON archive: "+e.message]}; }
}

function openDb() {
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open(DB_NAME,DB_VERSION);
    request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains(STORE)){const store=db.createObjectStore(STORE,{keyPath:"id"});store.createIndex("symbol","manifest.symbol",{unique:false});store.createIndex("importedAt","manifest.importedAt",{unique:false});}if(!db.objectStoreNames.contains("replayReports")){const reports=db.createObjectStore("replayReports",{keyPath:"id"});reports.createIndex("savedAt","savedAt",{unique:false});}};
    request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error);
  });
}
export async function saveArchive(archive) {
  const db=await openDb();
  const {symbol,provider,sourceReference,dataKind,startAt,endAt,tickCount}=archive.manifest;
  const bytes=new TextEncoder().encode(JSON.stringify({symbol,provider,sourceReference,dataKind,startAt,endAt,tickCount,quotes:archive.quotes}));
  const digest=await crypto.subtle.digest("SHA-256",bytes);
  const id=[...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,"0")).join("");
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE,"readwrite");
    tx.objectStore(STORE).put({id,manifest:archive.manifest,quotes:archive.quotes});
    tx.oncomplete=()=>{db.close();resolve(id);};tx.onerror=()=>{db.close();reject(tx.error);};
  });
}
export async function listArchives() {
  const db=await openDb();
  return new Promise((resolve,reject)=>{
    const req=db.transaction(STORE,"readonly").objectStore(STORE).getAll();
    req.onsuccess=()=>{db.close();resolve(req.result.map(({id,manifest})=>({id,manifest})).sort((a,b)=>b.manifest.importedAt.localeCompare(a.manifest.importedAt)));};
    req.onerror=()=>{db.close();reject(req.error);};
  });
}
export async function exportArchive(id) {
  const db=await openDb();
  return new Promise((resolve,reject)=>{
    const req=db.transaction(STORE,"readonly").objectStore(STORE).get(id);
    req.onsuccess=()=>{db.close();resolve(req.result||null);};req.onerror=()=>{db.close();reject(req.error);};
  });
}
export async function deleteArchive(id) {
  const db=await openDb();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE,"readwrite");tx.objectStore(STORE).delete(id);
    tx.oncomplete=()=>{db.close();resolve(true);};tx.onerror=()=>{db.close();reject(tx.error);};
  });
}

export async function saveReplayReport(report) {
  const db=await openDb();
  const serialized=JSON.stringify(report);
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(serialized));
  const id=[...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,"0")).join("");
  return new Promise((resolve,reject)=>{
    const tx=db.transaction("replayReports","readwrite");
    tx.objectStore("replayReports").put({id,savedAt:new Date().toISOString(),report});
    tx.oncomplete=()=>{db.close();resolve(id);};tx.onerror=()=>{db.close();reject(tx.error);};
  });
}
export async function listReplayReports() {
  const db=await openDb();
  return new Promise((resolve,reject)=>{
    const req=db.transaction("replayReports","readonly").objectStore("replayReports").getAll();
    req.onsuccess=()=>{db.close();resolve(req.result.map(({id,savedAt,report})=>({id,savedAt,symbol:report.archive.symbol,provider:report.archive.provider,signalCount:report.signalCount,signalSource:report.signalSource})).sort((a,b)=>b.savedAt.localeCompare(a.savedAt)));};
    req.onerror=()=>{db.close();reject(req.error);};
  });
}
export async function getReplayReport(id) {
  const db=await openDb();
  return new Promise((resolve,reject)=>{
    const req=db.transaction("replayReports","readonly").objectStore("replayReports").get(id);
    req.onsuccess=()=>{db.close();resolve(req.result?.report||null);};req.onerror=()=>{db.close();reject(req.error);};
  });
}
export async function deleteReplayReport(id) {
  const db=await openDb();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction("replayReports","readwrite");tx.objectStore("replayReports").delete(id);
    tx.oncomplete=()=>{db.close();resolve(true);};tx.onerror=()=>{db.close();reject(tx.error);};
  });
}

if (typeof document !== "undefined") {
  const $=id=>document.getElementById(id);
  const status=$("archiveStatus"), list=$("archiveList");
  const show=(message,error=false)=>{status.textContent=message;status.dataset.error=String(error);};
  const fmt=n=>n==null?"—":Number(n).toLocaleString();
  const esc=value=>String(value).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  async function renderList(){
    const archives=await listArchives();
    if(!archives.length){list.innerHTML='<p class="muted">No local archives imported.</p>';return;}
    list.innerHTML=archives.map(({id,manifest:m})=>'<article class="archive"><b>'+m.symbol+' · '+esc(m.provider)+'</b><small>'+m.startAt+' → '+m.endAt+'</small><small>'+fmt(m.tickCount)+' ticks · SHA-256 '+id.slice(0,16)+'…</small><small>Train '+fmt(m.partitions.train.tickCount)+' · Validation '+fmt(m.partitions.validation.tickCount)+' · Held-out test '+fmt(m.partitions.heldOutTest.tickCount)+'</small><div class="row"><button data-export="'+id+'">EXPORT</button><button data-delete="'+id+'" class="quiet">DELETE</button></div></article>').join("");
    list.querySelectorAll("[data-export]").forEach(b=>b.onclick=async()=>{const item=await exportArchive(b.dataset.export);if(!item)return;const blob=new Blob([JSON.stringify({metadata:{symbol:item.manifest.symbol,provider:item.manifest.provider,sourceReference:item.manifest.sourceReference,dataKind:"tick"},quotes:item.quotes})],{type:"application/json"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=item.manifest.symbol+"-"+item.id.slice(0,12)+".json";a.click();URL.revokeObjectURL(url);});
    list.querySelectorAll("[data-delete]").forEach(b=>b.onclick=async()=>{await deleteArchive(b.dataset.delete);await renderList();show("Archive deleted from this browser only.");});
  }
  $("archiveImport").addEventListener("submit",async event=>{
    event.preventDefault();const file=$("archiveFile").files[0];if(!file){show("Select a CSV or JSON file.",true);return;}
    if(file.size>MAX_FILE_BYTES){show("File exceeds the 25 MB browser import limit.",true);return;}
    const metadata={symbol:$("archiveSymbol").value,provider:$("archiveProvider").value.trim(),sourceReference:$("archiveSource").value.trim(),dataKind:"tick"};
    $("archiveSubmit").disabled=true;show("Reading and validating tick archive…");
    try{const result=parseArchiveFile({name:file.name,text:await file.text(),metadata});if(!result.ok){show(result.errors.join(" "),true);return;}
      const id=await saveArchive(result);const m=result.manifest;
      show("Validated and stored locally. "+fmt(m.tickCount)+" ticks · median interval "+fmt(m.medianIntervalMs)+" ms · p95 "+fmt(m.p95IntervalMs)+" ms · maximum gap "+fmt(m.maxGapMs)+" ms. SHA-256 "+id+".");
      event.target.reset();await renderList();
    }catch(error){show("Import failed: "+error.message,true);}finally{$("archiveSubmit").disabled=false;}
  });
  renderList().catch(error=>show("Local archive storage unavailable: "+error.message,true));
}
