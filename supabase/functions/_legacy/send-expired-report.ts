// EXPIRED SUBSCRIPTIONS weekly report (Corporate stream): covering email + branded PDF listing
// HubSpot tickets whose Subscription End Date (subscription_end_date) has passed, in the pipeline
// set by portal_settings.expired_report_pipeline (default '0' = Annual Corporate Services).
// v2: uses subscription_end_date + subscription_renewal_status.
// v3: excludes stages in portal_settings.expired_report_exclude_stages (default 'Renewal,Disengaged').
// v4: numbered rows; non-preview runs archive the PDF to the private 'expired-reports' storage
//     bucket (upsert by date) so each week's file is downloadable from the console.
// v5: per-owner personal lists. After the main send, every active summary_recipients row with
//     stream='expired_owners' whose email matches a HubSpot ticket owner receives an email with
//     a PDF of ONLY their tickets (matched via hubspot_owner_id -> /crm/v3/owners email, needs
//     the crm.objects.owners.read scope). Owners with no expired tickets that week get nothing.
//     Personal PDFs are not archived; owner-send failures log under expired_owner_error and
//     never block or retry the main run.
// Requires portal_settings.hubspot_token (HubSpot private app token, tickets read scope).
// Reliability pattern per send-general-report v6; failures log under expired_report_error.
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
async function logError(runDate:string,detail:string,kind="expired_report_error"){
  try{ await supabase.from("send_log").upsert({kind,run_date:runDate,detail:String(detail).slice(0,500)},{onConflict:"kind,run_date"}); }catch(_e){}
}
const HS="https://api.hubapi.com";
async function hsFetch(token:string,path:string,init?:RequestInit){
  const r=await fetch(HS+path,{...init,headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`,...(init?.headers||{})},signal:AbortSignal.timeout(15000)});
  if(!r.ok) throw new Error(`HubSpot ${path} ${r.status}: ${(await r.text()).slice(0,300)}`);
  return await r.json();
}
async function fetchExpiredTickets(token:string,pipeline:string,todayMs:number){
  const tickets:any[]=[];let after:string|undefined=undefined;
  for(let page=0;page<10;page++){
    const body:any={filterGroups:[{filters:[
      {propertyName:"hs_pipeline",operator:"EQ",value:pipeline},
      {propertyName:"subscription_end_date",operator:"LT",value:String(todayMs)}
    ]}],sorts:[{propertyName:"subscription_end_date",direction:"ASCENDING"}],
    properties:["subject","subscription_end_date","subscription_renewal_status","hs_pipeline_stage","hubspot_owner_id"],limit:100};
    if(after)body.after=after;
    const res=await hsFetch(token,"/crm/v3/objects/tickets/search",{method:"POST",body:JSON.stringify(body)});
    tickets.push(...(res.results||[]));
    after=res.paging?.next?.after;
    if(!after)break;
  }
  return tickets;
}
async function fetchStageLabels(token:string,pipeline:string){
  try{const res=await hsFetch(token,`/crm/v3/pipelines/tickets/${pipeline}`);
    const map=new Map<string,string>();for(const s of (res.stages||[]))map.set(String(s.id),s.label);
    return{label:res.label as string,stages:map};
  }catch(_e){return{label:"",stages:new Map<string,string>()};}
}
// Owner id -> lowercased email. Needs crm.objects.owners.read; on failure returns the error
// string so the run can proceed (main report is never blocked by owner lookups).
async function fetchOwners(token:string):Promise<{map:Map<string,string>,error:string|null}>{
  const map=new Map<string,string>();
  try{
    let after:string|undefined=undefined;
    for(let page=0;page<10;page++){
      const res=await hsFetch(token,`/crm/v3/owners?limit=100${after?`&after=${encodeURIComponent(after)}`:""}`);
      for(const o of (res.results||[])) if(o.email) map.set(String(o.id),String(o.email).toLowerCase());
      after=res.paging?.next?.after;
      if(!after)break;
    }
    return{map,error:null};
  }catch(e){ return{map,error:String(e)}; }
}
const raw=(s:any)=>s==null||s===""?"-":String(s);
function prettify(iso:string|null|undefined){if(!iso)return"-";const d=String(iso).slice(0,10).split("-");return d.length===3?`${d[2]}/${d[1]}/${d[0]}`:String(iso);}
async function buildPdf(prettyDate:string,pipelineLabel:string,rows:{subject:string,end:string,days:number,renewal:string,stage:string}[],note:string,subtitle="Weekly List"){
  const doc=await PDFDocument.create();
  let font:any,bold:any,uni=true;
  try{doc.registerFontkit(fontkit as any);const f=await loadFonts();font=await doc.embedFont(f.reg,{subset:true});bold=await doc.embedFont(f.bold,{subset:true});}
  catch(_e){uni=false;font=await doc.embedFont(StandardFonts.Helvetica);bold=await doc.embedFont(StandardFonts.HelveticaBold);}
  const clean=(s:string)=>uni?s:s.replace(/[^\x20-\x7E -ÿ]/g,"?");
  const blue=rgb(0x4f/255,0x75/255,0xff/255),grey=rgb(.89,.87,.85),soft=rgb(.93,.95,1),black=rgb(.06,.08,.09),red=rgb(.69,0,.13);
  const W=595,H=842,M=40;
  const cols=[{t:"#",w:26},{t:"Ticket",w:189},{t:"Stage",w:95},{t:"Expired on",w:68},{t:"Days",w:37},{t:"Renewal status",w:100}];
  const TW=cols.reduce((s,c)=>s+c.w,0);
  function wrap(text:string,width:number,size:number,f:any):string[]{const words=String(text).split(/\s+/);const lines:string[]=[];let line="";for(const w of words){let word=w;while(f.widthOfTextAtSize(word,size)>width-8&&word.length>4){let cut=word.length-1;while(cut>1&&f.widthOfTextAtSize(word.slice(0,cut),size)>width-8)cut--;if(line){lines.push(line);line="";}lines.push(word.slice(0,cut));word=word.slice(cut);}const test=line?line+" "+word:word;if(f.widthOfTextAtSize(test,size)<=width-8)line=test;else{if(line)lines.push(line);line=word;}}if(line)lines.push(line);return lines.length?lines:["-"];}
  let page=doc.addPage([W,H]);
  let y=0;
  const newPage=()=>{page=doc.addPage([W,H]);y=H-50;};
  const headerRow=()=>{let x=M;page.drawRectangle({x:M,y:y-4,width:TW,height:18,color:blue});for(const c of cols){page.drawText(c.t,{x:x+4,y,size:8,font:bold,color:rgb(1,1,1)});x+=c.w;}y-=20;};
  page.drawRectangle({x:0,y:H-84,width:W,height:84,color:blue});
  const grid=["..P..",".L.L.","F.P.F",".L.L.","..P.."];
  grid.forEach((row,ri)=>row.split("").forEach((ch,ci)=>{if(ch!==".")page.drawText(ch,{x:M+ci*10,y:H-30-ri*10,size:9,font:bold,color:rgb(0,0,0)});}));
  page.drawText("PHILIPPOU LAW FIRM",{x:M+70,y:H-30,size:8,font:bold,color:rgb(.92,.94,1)});
  page.drawText(clean(`Expired Subscriptions — ${subtitle}`),{x:M+70,y:H-48,size:15,font:bold,color:rgb(1,1,1)});
  page.drawText(clean(`${pipelineLabel} — as of ${prettyDate}`),{x:M+70,y:H-64,size:10,font,color:rgb(.92,.94,1)});
  y=H-104;
  page.drawText(clean(`${rows.length} expired ticket${rows.length===1?"":"s"}.`),{x:M,y,size:9.5,font:bold,color:rows.length?red:black});
  y-=12;
  if(note){page.drawText(clean(note),{x:M,y,size:8,font,color:rgb(.45,.45,.45)});y-=14;}
  y-=6;
  if(!rows.length){
    page.drawText("No expired subscriptions this week.",{x:M,y,size:10,font,color:black});
  } else {
    headerRow();
    let ri=0;
    for(const r of rows){
      const vals=[String(ri+1),raw(r.subject),raw(r.stage),prettify(r.end),String(r.days),raw(r.renewal)].map(clean);
      const cl=vals.map((v,i)=>wrap(v,cols[i].w,8.5,i===1?bold:font));
      const rowH=Math.max(...cl.map(l=>l.length))*11+8;
      if(y-rowH<50){newPage();headerRow();}
      if(ri%2===1)page.drawRectangle({x:M,y:y-rowH+13,width:TW,height:rowH,color:soft});
      let x=M;vals.forEach((_,i)=>{cl[i].forEach((line,li)=>{page.drawText(line,{x:x+4,y:y-li*11,size:8.5,font:i===1?bold:font,color:(i===4&&r.days>30)?red:black});});x+=cols[i].w;});
      page.drawLine({start:{x:M,y:y-rowH+11},end:{x:M+TW,y:y-rowH+11},thickness:.5,color:grey});
      y-=rowH;ri++;
    }
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
    const schedDay = settings.expired_report_day||"Fri";
    const schedHour = parseInt(settings.expired_report_hour??"9",10);
    if(!force && !(now.weekday===schedDay && now.hour>=schedHour)) return new Response(JSON.stringify({skipped:true,reason:"outside schedule window",now,schedDay,schedHour}),{status:200});
    const { data: logRow } = await supabase.from("send_log").select("id").eq("kind","expired_report").eq("run_date",now.date).maybeSingle();
    if(logRow && !force) return new Response(JSON.stringify({skipped:true,reason:"already sent"}),{status:200});

    stage="hubspot token";
    const token = settings.hubspot_token;
    if(!token){ await logError(now.date,"hubspot_token not set in portal_settings"); return new Response(JSON.stringify({skipped:true,reason:"hubspot_token not set"}),{status:200}); }

    stage="fetch tickets";
    const pipeline = settings.expired_report_pipeline || "0";
    const todayMs = Date.parse(now.date+"T00:00:00Z");
    const [tickets, pipeInfo] = await Promise.all([fetchExpiredTickets(token,pipeline,todayMs), fetchStageLabels(token,pipeline)]);

    const excludeRawStr = settings.expired_report_exclude_stages ?? "Renewal,Disengaged";
    const excludeTerms = excludeRawStr.split(",").map((s:string)=>s.trim().toLowerCase()).filter(Boolean);
    const excludedIds = new Set<string>();
    if(excludeTerms.length){
      for(const [id,label] of pipeInfo.stages.entries()){
        if(excludeTerms.includes(String(label).toLowerCase()) || excludeTerms.includes(String(id).toLowerCase())) excludedIds.add(String(id));
      }
      for(const t of excludeTerms) if(/^\d+$/.test(t)) excludedIds.add(t);
    }
    const excludedNames = excludeTerms.length ? excludeRawStr : "";

    const all = tickets.map((t:any)=>{const p=t.properties||{};const end=String(p.subscription_end_date||"").slice(0,10);
      const days=end?Math.max(0,Math.floor((todayMs-Date.parse(end+"T00:00:00Z"))/86400000)):0;
      return{subject:p.subject||String(t.id),end,days,renewal:p.subscription_renewal_status||"-",stageId:String(p.hs_pipeline_stage),stage:pipeInfo.stages.get(String(p.hs_pipeline_stage))||raw(p.hs_pipeline_stage),ownerId:String(p.hubspot_owner_id||"")};});
    const rows = all.filter(r=>!excludedIds.has(r.stageId));
    const excludedCount = all.length - rows.length;
    const excludedNote = excludedNames ? `Excluding stages: ${excludedNames} (${excludedCount} ticket${excludedCount===1?"":"s"} hidden).` : "";

    const [yy,mm,dd]=now.date.split("-");const prettyDate=`${dd}/${mm}/${yy}`;
    const pipelineLabel=pipeInfo.label||"Annual Corporate Services";

    stage="build pdf";
    const pdfB64=await buildPdf(prettyDate,pipelineLabel,rows,excludedNote);
    const pdfName=`PLF-Expired-Subscriptions-${now.date}.pdf`;

    stage="archive pdf";
    let archived=false;
    if(!preview){
      try{
        const bytes=Uint8Array.from(atob(pdfB64),(c)=>c.charCodeAt(0));
        const { error: upErr } = await supabase.storage.from("expired-reports").upload(pdfName,bytes,{contentType:"application/pdf",upsert:true});
        archived=!upErr;
        if(upErr) await logError(now.date,"archive failed: "+String(upErr.message||upErr));
      }catch(e){ await logError(now.date,"archive failed: "+String(e)); }
    }

    stage="resolve recipients";
    let recipients:string[];
    if(overrideTo){ recipients=overrideTo; }
    else {
      const rec=(settings.expired_report_recipient||settings.report_recipient||"").trim();
      recipients=rec?rec.split(/[,;]+/).map((s:string)=>s.trim()).filter(Boolean):[];
    }
    if(!recipients.length){ await logError(now.date,"no expired_report_recipient configured"); return new Response(JSON.stringify({skipped:true,reason:"no recipient"}),{status:200}); }

    const html=`<!DOCTYPE html><html><body style="margin:0;padding:0;background:#ffffff">
  <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.65;color:#101418;padding:22px 24px">
    <p style="margin:0 0 14px">Dear all,</p>
    <p style="margin:0 0 24px">Please find attached the weekly list of expired subscriptions in the ${pipelineLabel} pipeline (${rows.length} ticket${rows.length===1?"":"s"}) as of ${prettyDate}.</p>
    ${settings.email_signature||""}
  </div>
</body></html>`;

    stage="send";
    const subject=(preview?"[PREVIEW] ":"")+`Expired Subscriptions — ${prettyDate} (${rows.length})`;
    const r=await sendEmail(settings,recipients,subject,html,pdfB64,pdfName);
    if(!preview){
      if(r.ok) await supabase.from("send_log").upsert({kind:"expired_report",run_date:now.date,detail:r.detail},{onConflict:"kind,run_date"});
      else await logError(now.date,"send failed: "+r.detail);
    }

    // ---- Per-owner personal lists (skipped in preview; never blocks the main run) ----
    stage="owner lists";
    const owners={enabled:0,sent:0,skipped:0,failed:0,lookupError:null as string|null};
    if(!preview && r.ok){
      try{
        const { data: ownRecs } = await supabase.from("summary_recipients")
          .select("name,email").eq("stream","expired_owners").eq("active",true);
        const list=(ownRecs||[]).filter((x:any)=>x.email);
        owners.enabled=list.length;
        if(list.length){
          const ow=await fetchOwners(token);
          if(ow.error){
            owners.lookupError=ow.error;
            await logError(now.date,"owner lookup failed (add the crm.objects.owners.read scope to the HubSpot private app): "+ow.error,"expired_owner_error");
          } else {
            const emailToOwnerIds=new Map<string,string[]>();
            for(const [oid,em] of ow.map.entries()){
              if(!emailToOwnerIds.has(em)) emailToOwnerIds.set(em,[]);
              emailToOwnerIds.get(em)!.push(oid);
            }
            const fails:string[]=[];
            for(const rec of list){
              const em=String(rec.email).toLowerCase();
              const ids=emailToOwnerIds.get(em)||[];
              const mine=ids.length?rows.filter(rr=>ids.includes(rr.ownerId)):[];
              if(!mine.length){ owners.skipped++; continue; }
              const first=String(rec.name||"").split(/\s+/)[0]||"colleague";
              const pHtml=`<!DOCTYPE html><html><body style="margin:0;padding:0;background:#ffffff">
  <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.65;color:#101418;padding:22px 24px">
    <p style="margin:0 0 14px">Dear ${first},</p>
    <p style="margin:0 0 24px">Please find attached the list of your expired subscriptions in the ${pipelineLabel} pipeline (${mine.length} ticket${mine.length===1?"":"s"}) as of ${prettyDate}.</p>
    ${settings.email_signature||""}
  </div>
</body></html>`;
              const note=`Tickets owned by ${rec.name}.`+(excludedNote?" "+excludedNote:"");
              try{
                const pPdf=await buildPdf(prettyDate,pipelineLabel,mine,note,"Your Tickets");
                const safe=String(rec.name||"owner").replace(/[^A-Za-z0-9]+/g,"-").replace(/^-+|-+$/g,"")||"owner";
                const pr=await sendEmail(settings,[rec.email],`Your Expired Subscriptions — ${prettyDate} (${mine.length})`,pHtml,pPdf,`PLF-Expired-Subscriptions-${now.date}-${safe}.pdf`);
                if(pr.ok) owners.sent++; else { owners.failed++; fails.push(`${rec.email}: ${pr.detail}`.slice(0,120)); }
              }catch(e){ owners.failed++; fails.push(`${rec.email}: ${String(e)}`.slice(0,120)); }
            }
            if(fails.length) await logError(now.date,`owner sends failed (${owners.failed}/${owners.enabled}): `+fails.join(" | "),"expired_owner_error");
          }
        }
      }catch(e){ await logError(now.date,"owner lists crashed: "+String(e),"expired_owner_error"); }
    }

    return new Response(JSON.stringify({ok:r.ok,preview,archived,pipeline,pipelineLabel,count:rows.length,excluded:excludedCount,excludeStages:excludedNames,to:recipients,owners,detail:r.detail}),{headers:{"Content-Type":"application/json"}});
  } catch(e){
    await logError(runDate||new Date().toISOString().slice(0,10),`crashed at ${stage}: ${String(e)}`);
    return new Response(JSON.stringify({error:String(e),stage}),{status:500});
  }
});
