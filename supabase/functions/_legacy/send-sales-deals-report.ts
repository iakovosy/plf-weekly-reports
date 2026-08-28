// SALES DEALS weekly report: covering email + branded PDF analysing HubSpot DEALS created by
// sales reps (custom property sales_rep) in the Sales Pipeline, over a Wednesday->Wednesday week
// (Cyprus time). Sections: per-rep summary (created / converted / in progress / disengaged /
// conversion rate / EUR value), conversions that ENTERED the Converted stage during the week
// (any creation date), disengaged-this-week split into before-Quote-sent vs from-Quote-sent-onward
// (the lawyer meeting happens at Quote sent), each with Closed Lost Reason, and a hygiene list
// of new-business deals missing sales_rep.
// Schedule via portal_settings: sales_deals_report_day (default Wed), sales_deals_report_hour
// (default 8), sales_deals_report_recipient. Stage sets configurable via
// sales_deals_converted_stages (default '249514588,closedwon') and sales_deals_lost_stages
// (default 'closedlost'); pipeline via sales_deals_pipeline (default 'default').
// force:true bypasses the window; force+to => preview (no send_log row, [PREVIEW] subject).
// On a forced run outside the scheduled day the window is [last scheduled-day 00:00, now] so a
// mid-week test shows the running week. Requires portal_settings.hubspot_token (deals read).
// Failures log under sales_deals_report_error. Reliability pattern per send-expired-report v5.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";
import fontkit from "npm:@pdf-lib/fontkit@1.1.1";
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const FONT_REG="https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans.ttf";
const FONT_BOLD="https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans-Bold.ttf";
let FONT_CACHE:{reg:Uint8Array,bold:Uint8Array}|null=null;
async function loadFonts(){
  if(FONT_CACHE) return FONT_CACHE;
  const get=async(u:string)=>{const r=await fetch(u,{signal:AbortSignal.timeout(8000)});if(!r.ok)throw new Error("font "+r.status);return new Uint8Array(await r.arrayBuffer());};
  let last:unknown;
  for(let attempt=0;attempt<2;attempt++){
    try{const[a,b]=await Promise.all([get(FONT_REG),get(FONT_BOLD)]);FONT_CACHE={reg:a,bold:b};return FONT_CACHE;}
    catch(e){last=e;}
  }
  throw last;
}
function cyprusNow(){const p=new Intl.DateTimeFormat("en-GB",{timeZone:"Asia/Nicosia",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",weekday:"short",hour12:false}).formatToParts(new Date());const g=(t:string)=>p.find(x=>x.type===t)?.value??"";return{date:`${g("year")}-${g("month")}-${g("day")}`,hour:parseInt(g("hour"),10),weekday:g("weekday")};}
// UTC ms of 00:00 Asia/Nicosia on dateStr (handles EET/EEST).
function cyprusMidnightUTC(dateStr:string){
  const base=Date.parse(dateStr+"T00:00:00Z");
  for(const off of [3,2]){
    const cand=base-off*3600000;
    const p=new Intl.DateTimeFormat("en-GB",{timeZone:"Asia/Nicosia",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",hour12:false}).formatToParts(new Date(cand));
    const g=(t:string)=>p.find(x=>x.type===t)?.value??"";
    if(`${g("year")}-${g("month")}-${g("day")}`===dateStr&&(g("hour")==="00"||g("hour")==="24"))return cand;
  }
  return base-3*3600000;
}
function addDays(dateStr:string,n:number){return new Date(Date.parse(dateStr+"T00:00:00Z")+n*86400000).toISOString().slice(0,10);}
async function getSettings(){const{data,error}=await supabase.from("portal_settings").select("key,value");if(error)throw error;return Object.fromEntries(data.map((r:any)=>[r.key,r.value]));}
function parseFrom(from:string){const m=from.match(/^(.*)<([^>]+)>\s*$/);if(m)return{name:m[1].trim().replace(/^"|"$/g,"")||undefined,email:m[2].trim()};return{email:from.trim()};}
async function sendEmail(settings:Record<string,string>,to:string[],subject:string,html:string,pdfB64?:string,pdfName?:string){
  const from=settings.from_email||"PLF Reports <onboarding@resend.dev>";const brevoKey=settings.brevo_api_key;
  if(brevoKey){const f=parseFrom(from);const payload:any={sender:{email:f.email,name:f.name??"PLF Reports"},to:to.map(e=>({email:e})),subject,htmlContent:html};if(pdfB64)payload.attachment=[{name:pdfName,content:pdfB64}];const resp=await fetch("https://api.brevo.com/v3/smtp/email",{method:"POST",headers:{"Content-Type":"application/json","api-key":brevoKey},body:JSON.stringify(payload)});return{ok:resp.ok,detail:resp.ok?"sent":await resp.text()};}
  const resendKey=Deno.env.get("RESEND_API_KEY")||settings.resend_api_key;if(!resendKey)return{ok:false,detail:"No provider"};
  const payload:any={from,to,subject,html};if(pdfB64)payload.attachments=[{filename:pdfName,content:pdfB64}];
  const resp=await fetch("https://api.resend.com/emails",{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${resendKey}`},body:JSON.stringify(payload)});
  return{ok:resp.ok,detail:resp.ok?"sent":await resp.text()};
}
async function logError(runDate:string,detail:string,kind="sales_deals_report_error"){
  try{ await supabase.from("send_log").upsert({kind,run_date:runDate,detail:String(detail).slice(0,500)},{onConflict:"kind,run_date"}); }catch(_e){}
}
const HS="https://api.hubapi.com";
async function hsFetch(token:string,path:string,init?:RequestInit){
  const r=await fetch(HS+path,{...init,headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`,...(init?.headers||{})},signal:AbortSignal.timeout(15000)});
  if(!r.ok) throw new Error(`HubSpot ${path} ${r.status}: ${(await r.text()).slice(0,300)}`);
  return await r.json();
}
const DEAL_PROPS=["dealname","dealstage","sales_rep","createdate","amount","dealtype","closed_lost_reason","hs_v2_date_entered_249514588","hubspot_owner_id"];
async function searchDeals(token:string,filters:any[],extraProps:string[]=[]){
  const out:any[]=[];let after:string|undefined=undefined;
  for(let page=0;page<10;page++){
    const body:any={filterGroups:[{filters}],sorts:[{propertyName:"createdate",direction:"ASCENDING"}],properties:[...DEAL_PROPS,...extraProps],limit:100};
    if(after)body.after=after;
    const res=await hsFetch(token,"/crm/v3/objects/deals/search",{method:"POST",body:JSON.stringify(body)});
    out.push(...(res.results||[]));
    after=res.paging?.next?.after;
    if(!after)break;
  }
  return out;
}
async function fetchDealStages(token:string,pipeline:string){
  try{const res=await hsFetch(token,`/crm/v3/pipelines/deals/${pipeline}`);
    const map=new Map<string,{label:string,order:number}>();
    (res.stages||[]).forEach((s:any,i:number)=>map.set(String(s.id),{label:s.label,order:s.displayOrder??i}));
    return{label:res.label as string,stages:map};
  }catch(_e){return{label:"Sales Pipeline",stages:new Map<string,{label:string,order:number}>()};}
}
const raw=(s:any)=>s==null||s===""?"-":String(s);
function prettify(iso:string|null|undefined){if(!iso)return"-";const d=String(iso).slice(0,10).split("-");return d.length===3?`${d[2]}/${d[1]}/${d[0]}`:String(iso);}
const eur=(n:number)=>"€"+Math.round(n).toLocaleString("en-GB");
const num=(s:any)=>{const n=parseFloat(String(s??""));return isNaN(n)?0:n;};
type Section={title:string,note?:string,cols:{t:string,w:number}[],rows:string[][],redCol?:number,lines?:string[]};
async function buildPdf(title:string,subtitle:string,sections:Section[]){
  const doc=await PDFDocument.create();
  let font:any,bold:any,uni=true;
  try{doc.registerFontkit(fontkit as any);const f=await loadFonts();font=await doc.embedFont(f.reg,{subset:true});bold=await doc.embedFont(f.bold,{subset:true});}
  catch(_e){uni=false;font=await doc.embedFont(StandardFonts.Helvetica);bold=await doc.embedFont(StandardFonts.HelveticaBold);}
  const clean=(s:string)=>uni?s:s.replace(/[^\x20-\x7E -ÿ]/g,"?");
  const blue=rgb(0x4f/255,0x75/255,0xff/255),grey=rgb(.89,.87,.85),soft=rgb(.93,.95,1),black=rgb(.06,.08,.09),red=rgb(.69,0,.13),navy=rgb(0x27/255,0x54/255,0x8a/255);
  const W=595,H=842,M=40;
  function wrap(text:string,width:number,size:number,f:any):string[]{const words=String(text).split(/\s+/);const lines:string[]=[];let line="";for(const w of words){let word=w;while(f.widthOfTextAtSize(word,size)>width-8&&word.length>4){let cut=word.length-1;while(cut>1&&f.widthOfTextAtSize(word.slice(0,cut),size)>width-8)cut--;if(line){lines.push(line);line="";}lines.push(word.slice(0,cut));word=word.slice(cut);}const test=line?line+" "+word:word;if(f.widthOfTextAtSize(test,size)<=width-8)line=test;else{if(line)lines.push(line);line=word;}}if(line)lines.push(line);return lines.length?lines:["-"];}
  let page=doc.addPage([W,H]);
  let y=0;
  const newPage=()=>{page=doc.addPage([W,H]);y=H-50;};
  page.drawRectangle({x:0,y:H-84,width:W,height:84,color:blue});
  const grid=["..P..",".L.L.","F.P.F",".L.L.","..P.."];
  grid.forEach((row,ri)=>row.split("").forEach((ch,ci)=>{if(ch!==".")page.drawText(ch,{x:M+ci*10,y:H-30-ri*10,size:9,font:bold,color:rgb(0,0,0)});}));
  page.drawText("PHILIPPOU LAW FIRM",{x:M+70,y:H-30,size:8,font:bold,color:rgb(.92,.94,1)});
  page.drawText(clean(title),{x:M+70,y:H-48,size:15,font:bold,color:rgb(1,1,1)});
  page.drawText(clean(subtitle),{x:M+70,y:H-64,size:10,font,color:rgb(.92,.94,1)});
  y=H-108;
  for(const sec of sections){
    const cols=sec.cols;const TW=cols.reduce((s,c)=>s+c.w,0);
    const headerRow=()=>{let x=M;page.drawRectangle({x:M,y:y-4,width:TW,height:18,color:blue});for(const c of cols){page.drawText(clean(c.t),{x:x+4,y,size:8,font:bold,color:rgb(1,1,1)});x+=c.w;}y-=20;};
    if(y<120)newPage();
    page.drawText(clean(sec.title.toUpperCase()),{x:M,y,size:10,font:bold,color:navy});
    page.drawLine({start:{x:M,y:y-4},end:{x:M+140,y:y-4},thickness:1.2,color:blue});
    y-=14;
    if(sec.note){page.drawText(clean(sec.note),{x:M,y,size:8,font,color:rgb(.45,.45,.45)});y-=14;}
    if(sec.lines){
      for(const ln of sec.lines){if(y<70)newPage();page.drawText(clean(ln),{x:M,y,size:9,font,color:black});y-=13;}
      y-=14;continue;
    }
    if(!sec.rows.length){page.drawText("Nothing to show.",{x:M,y,size:9.5,font,color:black});y-=26;continue;}
    headerRow();
    let ri=0;
    for(const r of sec.rows){
      const vals=r.map(clean);
      const isTotal=vals[0]==="TOTAL";
      const rowFont=(i:number)=>(i===0||isTotal)?bold:font;
      const cl=vals.map((v,i)=>wrap(v,cols[i].w,8.5,rowFont(i)));
      const rowH=Math.max(...cl.map(l=>l.length))*11+8;
      if(y-rowH<50){newPage();headerRow();}
      if(isTotal)page.drawRectangle({x:M,y:y-rowH+13,width:TW,height:rowH,color:rgb(.88,.91,1)});
      else if(ri%2===1)page.drawRectangle({x:M,y:y-rowH+13,width:TW,height:rowH,color:soft});
      let x=M;vals.forEach((_,i)=>{cl[i].forEach((line,li)=>{page.drawText(line,{x:x+4,y:y-li*11,size:8.5,font:rowFont(i),color:(sec.redCol===i&&!isTotal&&line!=="0"&&line!=="-")?red:black});});x+=cols[i].w;});
      page.drawLine({start:{x:M,y:y-rowH+11},end:{x:M+TW,y:y-rowH+11},thickness:.5,color:grey});
      y-=rowH;ri++;
    }
    y-=22;
  }
  for(const p of doc.getPages())p.drawText("Generated automatically — All Rights Reserved © Philippou Law Firm",{x:M,y:28,size:7.5,font,color:rgb(.6,.6,.6)});
  return await doc.saveAsBase64();
}
Deno.serve(async (req) => {
  let stage="init", runDate="";
  try {
    const settings = await getSettings();
    if (req.headers.get("x-cron-secret") !== settings.cron_secret) return new Response(JSON.stringify({error:"unauthorized"}),{status:401});
    const body = await req.json().catch(()=>({}));
    const force = body.force === true;
    const overrideTo:string[]|null = force ? (typeof body.to==="string" ? [body.to] : Array.isArray(body.to) ? body.to : null) : null;
    const preview = !!overrideTo;
    const now = cyprusNow();
    runDate = now.date;
    const schedDay = settings.sales_deals_report_day||"Wed";
    const schedHour = parseInt(settings.sales_deals_report_hour??"8",10);
    if(!force && !(now.weekday===schedDay && now.hour>=schedHour)) return new Response(JSON.stringify({skipped:true,reason:"outside schedule window",now,schedDay,schedHour}),{status:200});
    const { data: logRow } = await supabase.from("send_log").select("id").eq("kind","sales_deals_report").eq("run_date",now.date).maybeSingle();
    if(logRow && !force) return new Response(JSON.stringify({skipped:true,reason:"already sent"}),{status:200});

    stage="hubspot token";
    const token = settings.hubspot_token;
    if(!token){ await logError(now.date,"hubspot_token not set in portal_settings"); return new Response(JSON.stringify({skipped:true,reason:"hubspot_token not set"}),{status:200}); }

    stage="window";
    // Week window: [previous scheduled-day 00:00 Cyprus, this scheduled-day 00:00 Cyprus).
    // Forced run on another day: [most recent scheduled-day 00:00, now] so a mid-week test shows the running week.
    const DAYIDX:Record<string,number>={Mon:0,Tue:1,Wed:2,Thu:3,Fri:4,Sat:5,Sun:6};
    const daysSince=((DAYIDX[now.weekday]??0)-(DAYIDX[schedDay]??2)+7)%7;
    let startMs:number,endMs:number,startLabel:string,endLabel:string,partial=false;
    if(daysSince===0){
      endMs=cyprusMidnightUTC(now.date);startMs=cyprusMidnightUTC(addDays(now.date,-7));
      startLabel=addDays(now.date,-7);endLabel=now.date;
    }else{
      const lastSched=addDays(now.date,-daysSince);
      startMs=cyprusMidnightUTC(lastSched);endMs=Date.now();
      startLabel=lastSched;endLabel=now.date;partial=true;
    }

    stage="fetch deals";
    const pipeline=settings.sales_deals_pipeline||"default";
    const convertedIds=new Set((settings.sales_deals_converted_stages||"249514588,closedwon").split(",").map((s:string)=>s.trim()).filter(Boolean));
    const lostIds=new Set((settings.sales_deals_lost_stages||"closedlost").split(",").map((s:string)=>s.trim()).filter(Boolean));
    const pipeInfo=await fetchDealStages(token,pipeline);
    const stageLabel=(id:string)=>pipeInfo.stages.get(String(id))?.label||raw(id);

    // Pivot = the lawyer meeting, which happens at the "Quote sent" stage. A disengaged deal that
    // reached Quote sent (or any later stage) had the meeting; one that never did dropped before it.
    // Auto-detect by label; override with portal_settings.sales_deals_quote_sent_stage (id or label).
    const norm=(x:string)=>String(x).toLowerCase().replace(/[^a-z0-9]/g,"");
    const quoteOverride=(settings.sales_deals_quote_sent_stage||"").trim();
    let quoteSentId="";
    if(quoteOverride){ if(pipeInfo.stages.has(quoteOverride))quoteSentId=quoteOverride; else for(const[id,st]of pipeInfo.stages){if(norm(st.label)===norm(quoteOverride)){quoteSentId=id;break;}} }
    if(!quoteSentId)for(const[id,st]of pipeInfo.stages){if(norm(st.label).includes("quotesent")){quoteSentId=id;break;}}
    const quoteOrder=quoteSentId?(pipeInfo.stages.get(quoteSentId)?.order??99):Infinity;
    // stage-entry timestamp props for Quote sent + every later non-lost stage (= "had the meeting")
    const reachedProps:string[]=[];
    if(quoteSentId)for(const[id,st]of pipeInfo.stages){ if(!lostIds.has(id)&&(st.order??99)>=quoteOrder)reachedProps.push(`hs_v2_date_entered_${id}`); }

    const pipeFilter={propertyName:"pipeline",operator:"EQ",value:pipeline};
    const [createdDeals,convertedThisWeek,lostThisWeek]=await Promise.all([
      searchDeals(token,[pipeFilter,{propertyName:"createdate",operator:"GTE",value:String(startMs)},{propertyName:"createdate",operator:"LT",value:String(endMs)}]),
      searchDeals(token,[pipeFilter,{propertyName:"hs_v2_date_entered_249514588",operator:"GTE",value:String(startMs)},{propertyName:"hs_v2_date_entered_249514588",operator:"LT",value:String(endMs)}]),
      searchDeals(token,[pipeFilter,{propertyName:"hs_v2_date_entered_closedlost",operator:"GTE",value:String(startMs)},{propertyName:"hs_v2_date_entered_closedlost",operator:"LT",value:String(endMs)}],["hs_v2_date_entered_closedlost",...reachedProps])
    ]);

    stage="aggregate";
    type RepAgg={created:number,clients:number,open:number,lost:number,value:number};
    const reps=new Map<string,RepAgg>();
    const repOf=(t:any)=>String(t.properties?.sales_rep||"").trim();
    const get=(name:string)=>{if(!reps.has(name))reps.set(name,{created:0,clients:0,open:0,lost:0,value:0});return reps.get(name)!;};
    const hygiene:string[]=[];
    for(const d of createdDeals){
      const p=d.properties||{};const rep=repOf(d);
      if(!rep){ if(String(p.dealtype||"")==="newbusiness") hygiene.push(`${p.dealname||d.id} — stage: ${stageLabel(p.dealstage)}, created ${prettify(p.createdate)}`); continue; }
      const a=get(rep);a.created++;a.value+=num(p.amount);
      const st=String(p.dealstage||"");
      if(convertedIds.has(st))a.clients++;else if(lostIds.has(st))a.lost++;else a.open++;
    }
    // also flag conversions this week that carry no rep (attribution gap)
    for(const d of convertedThisWeek){ if(!repOf(d)&&String(d.properties?.dealtype||"")==="newbusiness"){const p=d.properties||{};const line=`${p.dealname||d.id} — CONVERTED this week, no sales rep (created ${prettify(p.createdate)})`;if(!hygiene.some(h=>h.startsWith(String(p.dealname||d.id))))hygiene.push(line);} }
    const repOrder=[...reps.entries()].sort((a,b)=>b[1].created-a[1].created||a[0].localeCompare(b[0]));
    const tot={created:0,clients:0,open:0,lost:0,value:0};
    for(const[,a]of repOrder){tot.created+=a.created;tot.clients+=a.clients;tot.open+=a.open;tot.lost+=a.lost;tot.value+=a.value;}
    const rate=(c:number,n:number)=>n?Math.round((c/n)*100)+"%":"-";
    const summaryRows=repOrder.map(([name,a])=>[name,String(a.created),String(a.clients),String(a.open),String(a.lost),rate(a.clients,a.created),eur(a.value)]);
    if(summaryRows.length)summaryRows.push(["TOTAL",String(tot.created),String(tot.clients),String(tot.open),String(tot.lost),rate(tot.clients,tot.created),eur(tot.value)]);

    const convRep=convertedThisWeek.filter(d=>repOf(d));
    const convRows=convRep.map((d,i)=>{const p=d.properties||{};return[String(i+1),raw(p.dealname),repOf(d),prettify(p.createdate),p.amount?eur(num(p.amount)):"-"];});
    const convValue=convRep.reduce((s,d)=>s+num(d.properties?.amount),0);

    const lostRep=lostThisWeek.filter(d=>repOf(d));
    // Had the meeting? => entered Quote sent or any later stage before disengaging.
    const reachedQuote=(d:any)=>{const p=d.properties||{};return reachedProps.some(k=>{const v=p[k];return v!=null&&String(v).trim()!=="";});};
    const splitOk=!!quoteSentId;
    const lostBefore=splitOk?lostRep.filter(d=>!reachedQuote(d)):lostRep;
    const lostAfter =splitOk?lostRep.filter(d=> reachedQuote(d)):[];
    const lostRowsOf=(list:any[])=>list.map((d,i)=>{const p=d.properties||{};return[String(i+1),raw(p.dealname),repOf(d),raw(p.closed_lost_reason)];});
    const beforeRows=lostRowsOf(lostBefore);
    const afterRows=lostRowsOf(lostAfter);

    const prettyRange=`${prettify(startLabel)} – ${prettify(endLabel)}`;
    const [yy2,mm2,dd2]=now.date.split("-");const prettyToday=`${dd2}/${mm2}/${yy2}`;

    stage="build pdf";
    const sections:Section[]=[
      {title:`Per sales rep — deals created this week`,note:`Deals created ${prettyRange}${partial?" (week in progress)":""}. Clients = reached Converted/Completed. Value = sum of deal amounts.`,
        cols:[{t:"Sales rep",w:135},{t:"Created",w:50},{t:"Clients",w:48},{t:"In prog.",w:52},{t:"Diseng.",w:52},{t:"Conv. %",w:52},{t:"Value €",w:75}],rows:summaryRows,redCol:4},
      {title:"Converted this week",note:`Deals that entered the Converted stage ${prettyRange}, whatever week they were created. Total value ${eur(convValue)}.`,
        cols:[{t:"#",w:24},{t:"Deal",w:200},{t:"Sales rep",w:110},{t:"Created",w:66},{t:"Amount",w:64}],rows:convRows},
      ...(splitOk?[
        {title:"Disengaged this week — before the lawyer meeting",note:`Deals that entered Disengaged ${prettyRange} without reaching Quote sent — dropped before the meeting with the lawyer. Reason as recorded on the deal.`,
          cols:[{t:"#",w:24},{t:"Deal",w:170},{t:"Sales rep",w:105},{t:"Reason",w:165}],rows:beforeRows},
        {title:"Disengaged this week — after the lawyer meeting",note:`Deals that reached Quote sent or later (the lawyer meeting happened) then entered Disengaged ${prettyRange}. Reason as recorded on the deal.`,
          cols:[{t:"#",w:24},{t:"Deal",w:170},{t:"Sales rep",w:105},{t:"Reason",w:165}],rows:afterRows}
      ]:[
        {title:"Disengaged this week",note:`Deals that entered Disengaged ${prettyRange}, with the reason recorded on the deal. (Quote sent stage not found — not split.)`,
          cols:[{t:"#",w:24},{t:"Deal",w:170},{t:"Sales rep",w:105},{t:"Reason",w:165}],rows:beforeRows}
      ])
    ];
    if(hygiene.length)sections.push({title:"Missing sales rep — check attribution",note:"New-business deals in this week's data with no sales rep recorded.",cols:[],rows:[],lines:hygiene.map((h,i)=>`${i+1}. ${h}`)});
    const pdfB64=await buildPdf("Sales Deals — Weekly Report",`${pipeInfo.label||"Sales Pipeline"} — week ${prettyRange}`,sections);
    const pdfName=`PLF-Sales-Deals-${now.date}.pdf`;

    stage="resolve recipients";
    let recipients:string[];
    if(overrideTo){ recipients=overrideTo; }
    else {
      const rec=(settings.sales_deals_report_recipient||"").trim();
      recipients=rec?rec.split(/[,;]+/).map((s:string)=>s.trim()).filter(Boolean):[];
    }
    if(!recipients.length){ await logError(now.date,"no sales_deals_report_recipient configured"); return new Response(JSON.stringify({skipped:true,reason:"no recipient"}),{status:200}); }

    const td='padding:6px 10px;border:1px solid #E2DDD9;font-size:13px';
    const th='padding:7px 10px;background:#4F75FF;color:#ffffff;text-align:left;font-size:12px';
    const tableHtml=summaryRows.length?`<table style="border-collapse:collapse;margin:14px 0">
      <tr><th style="${th}">Sales rep</th><th style="${th}">Created</th><th style="${th}">Clients</th><th style="${th}">In progress</th><th style="${th}">Disengaged</th><th style="${th}">Conv. %</th><th style="${th}">Value</th></tr>
      ${summaryRows.map(r=>`<tr${r[0]==="TOTAL"?' style="background:#EEF2FF;font-weight:bold"':''}><td style="${td}">${r[0]}</td><td style="${td};text-align:center">${r[1]}</td><td style="${td};text-align:center">${r[2]}</td><td style="${td};text-align:center">${r[3]}</td><td style="${td};text-align:center">${r[4]}</td><td style="${td};text-align:center">${r[5]}</td><td style="${td};text-align:right">${r[6]}</td></tr>`).join("")}
    </table>`:`<p style="margin:0 0 14px">No rep-created deals this week.</p>`;
    const html=`<!DOCTYPE html><html><body style="margin:0;padding:0;background:#ffffff">
  <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.65;color:#101418;padding:22px 24px">
    <p style="margin:0 0 14px">Dear all,</p>
    <p style="margin:0 0 6px">Please find below the weekly Sales deals report for <b>${prettyRange}</b>${partial?" (week in progress)":""}: ${tot.created} deal${tot.created===1?"":"s"} created by the sales team, ${convRep.length} conversion${convRep.length===1?"":"s"} this week (${eur(convValue)}), ${lostRep.length} disengaged.</p>
    ${tableHtml}
    <p style="margin:0 0 24px">The attached PDF adds this week's conversions and the disengaged leads with reasons, split into those that dropped before the lawyer meeting (Quote sent) and those that disengaged after it${hygiene.length?", plus "+hygiene.length+" deal"+(hygiene.length===1?"":"s")+" missing a sales rep":""}.</p>
    ${settings.email_signature||""}
  </div>
</body></html>`;

    stage="send";
    const subject=(preview?"[PREVIEW] ":"")+`Sales Deals Report — week ${prettyRange} (${tot.created} created, ${convRep.length} converted)`;
    const r=await sendEmail(settings,recipients,subject,html,pdfB64,pdfName);
    if(!preview){
      if(r.ok) await supabase.from("send_log").upsert({kind:"sales_deals_report",run_date:now.date,detail:r.detail},{onConflict:"kind,run_date"});
      else await logError(now.date,"send failed: "+r.detail);
    }
    return new Response(JSON.stringify({ok:r.ok,preview,partial,window:{start:startLabel,end:endLabel},created:tot.created,converted:convRep.length,disengaged:lostRep.length,hygiene:hygiene.length,reps:repOrder.map(([n,a])=>({rep:n,...a})),to:recipients,detail:r.detail,generated:prettyToday}),{headers:{"Content-Type":"application/json"}});
  } catch(e){
    await logError(runDate||new Date().toISOString().slice(0,10),`crashed at ${stage}: ${String(e)}`);
    return new Response(JSON.stringify({error:String(e),stage}),{status:500});
  }
});
