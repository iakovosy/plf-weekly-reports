// GENERAL weekly workload summary: short covering email + signature + branded PDF grouped by department.
// Reliability: fonts cached at module scope with timeout + retry; the schedule window is
// "correct day, at or past the scheduled hour, not already logged as sent" so a failed run
// self-heals on the next hourly tick. Failures are logged under general_report_error, which
// does NOT block a retry; only a genuine success writes general_report.
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
async function logError(runDate:string,detail:string){
  try{ await supabase.from("send_log").upsert({kind:"general_report_error",run_date:runDate,detail:String(detail).slice(0,500)},{onConflict:"kind,run_date"}); }catch(_e){}
}
const raw=(s:any)=>s==null||s===""?"-":String(s);
async function buildPdf(prettyDate:string, groups:{dept:string,rows:any[]}[], total:number, submittedCount:number, missingNames:string[]){
  const doc=await PDFDocument.create();
  let font:any,bold:any,uni=true;
  try{doc.registerFontkit(fontkit as any);const f=await loadFonts();font=await doc.embedFont(f.reg,{subset:true});bold=await doc.embedFont(f.bold,{subset:true});}
  catch(_e){uni=false;font=await doc.embedFont(StandardFonts.Helvetica);bold=await doc.embedFont(StandardFonts.HelveticaBold);}
  const clean=(s:string)=>uni?s:s.replace(/[^\x20-\x7E -ÿ]/g,"?");
  const blue=rgb(0x4f/255,0x75/255,0xff/255),navy=rgb(0x27/255,0x54/255,0x8a/255),grey=rgb(.89,.87,.85),soft=rgb(.93,.95,1),black=rgb(.06,.08,.09);
  const W=595,H=842,M=40;
  const cols=[{t:"Team member",w:150},{t:"Workload this week",w:150},{t:"Comments",w:215}];
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
  page.drawText("Weekly Workload Check-in — Summary",{x:M+70,y:H-48,size:15,font:bold,color:rgb(1,1,1)});
  page.drawText(`Week of ${prettyDate}`,{x:M+70,y:H-64,size:10,font,color:rgb(.92,.94,1)});
  y=H-104;
  page.drawText(clean(`${submittedCount}/${total} submitted.`),{x:M,y,size:9.5,font:bold,color:black});
  y-=14;
  if(missingNames.length){
    const ml=wrap(clean(`Not submitted: ${missingNames.join(", ")}`),TW,9,font);
    for(const line of ml){page.drawText(line,{x:M,y,size:9,font,color:rgb(.69,0,.13)});y-=11;}
  }
  y-=8;
  for(const g of groups){
    if(y-70<50)newPage();
    const sub=g.rows.filter((r:any)=>r.status==="submitted").length;
    page.drawRectangle({x:M,y:y-6,width:TW,height:20,color:navy});
    page.drawText(clean(`${g.dept}`),{x:M+7,y,size:9.5,font:bold,color:rgb(1,1,1)});
    page.drawText(clean(`${sub}/${g.rows.length} submitted`),{x:M+TW-92,y,size:8.5,font,color:rgb(.92,.94,1)});
    y-=26;
    headerRow();
    let ri=0;
    for(const r of g.rows){
      const a=r.answers||{};
      const done=r.status==="submitted";
      const wl=done?String(a.workload||""):"Not submitted";
      const vals=[raw(r.name),raw(wl),done?raw(a.comments):"-"].map(clean);
      const cl=vals.map((v,i)=>wrap(v,cols[i].w,8.5,i===0?bold:font));
      const rowH=Math.max(...cl.map(l=>l.length))*11+8;
      if(y-rowH<50){newPage();headerRow();}
      const bc=!done?"#EDEDED":wl.startsWith("100")?"#fbe4e7":wl.startsWith("90")?"#FFF7E0":"#ffffff";
      if(bc!=="#ffffff"){const cr=parseInt(bc.slice(1,3),16)/255,cg=parseInt(bc.slice(3,5),16)/255,cb=parseInt(bc.slice(5,7),16)/255;page.drawRectangle({x:M,y:y-rowH+13,width:TW,height:rowH,color:rgb(cr,cg,cb)});}
      else if(ri%2===1)page.drawRectangle({x:M,y:y-rowH+13,width:TW,height:rowH,color:soft});
      let x=M;vals.forEach((_,i)=>{cl[i].forEach((line,li)=>{page.drawText(line,{x:x+4,y:y-li*11,size:8.5,font:i===0?bold:font,color:(!done&&i===1)?rgb(.69,0,.13):black});});x+=cols[i].w;});
      page.drawLine({start:{x:M,y:y-rowH+11},end:{x:M+TW,y:y-rowH+11},thickness:.5,color:grey});
      y-=rowH;ri++;
    }
    y-=14;
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
    const schedDay = settings.general_report_day||"Tue";
    const schedHour = parseInt(settings.general_report_hour??"10",10);
    // At or past the scheduled hour, so a failed run retries next tick.
    if(!force && !(now.weekday===schedDay && now.hour>=schedHour)) return new Response(JSON.stringify({skipped:true,reason:"outside schedule window",now,schedDay,schedHour}),{status:200});

    stage="load submissions";
    const { data: latest } = await supabase.from("general_submissions").select("report_date").order("report_date",{ascending:false}).limit(1);
    if(!latest?.length) return new Response(JSON.stringify({skipped:true,reason:"no submissions"}),{status:200});
    const reportDate = latest[0].report_date as string;
    runDate = reportDate;
    const { data: logRow } = await supabase.from("send_log").select("id").eq("kind","general_report").eq("run_date",reportDate).maybeSingle();
    if(logRow && !force) return new Response(JSON.stringify({skipped:true,reason:"already sent"}),{status:200});

    const { data: rows } = await supabase.from("general_submissions").select("status, answers, general_admins!inner(name,email)").eq("report_date",reportDate);
    const { data: deps } = await supabase.rpc("report_departments");
    const depMap=new Map<string,{department:string,sort_order:number}>();
    for(const d of (deps||[])) depMap.set(String(d.email).toLowerCase(),{department:d.department,sort_order:d.sort_order});

    const list = (rows||[]).map((r:any)=>{
      const email=String(r.general_admins.email||"").toLowerCase();
      const d=depMap.get(email)||{department:"Unassigned",sort_order:9999};
      return {status:r.status,answers:r.answers,name:r.general_admins.name,email,dept:d.department,dord:d.sort_order};
    }).sort((a:any,b:any)=>a.name.localeCompare(b.name));

    const [yy,mm,dd]=reportDate.split("-");const prettyDate=`${dd}/${mm}/${yy}`;
    const submitted=list.filter((r:any)=>r.status==="submitted");
    const missing=list.filter((r:any)=>r.status!=="submitted");

    const byDept=new Map<string,any[]>();
    for(const r of list){ if(!byDept.has(r.dept))byDept.set(r.dept,[]); byDept.get(r.dept)!.push(r); }
    const groups=[...byDept.entries()].map(([dept,rs])=>({dept,rows:rs,dord:rs[0].dord}))
      .sort((a,b)=>a.dord-b.dord||a.dept.localeCompare(b.dept))
      .map(({dept,rows})=>({dept,rows}));

    const html=`<!DOCTYPE html><html><body style="margin:0;padding:0;background:#ffffff">
  <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.65;color:#101418;padding:22px 24px">
    <p style="margin:0 0 14px">Dear all,</p>
    <p style="margin:0 0 24px">Please find attached the results of the weekly workload (${prettyDate}).</p>
    ${settings.email_signature||""}
  </div>
</body></html>`;

    stage="build pdf";
    const pdfB64=await buildPdf(prettyDate,groups,list.length,submitted.length,missing.map((r:any)=>r.name));
    const pdfName=`PLF-Weekly-Workload-${reportDate}.pdf`;

    stage="resolve recipients";
    let recipients:string[];
    if(overrideTo){ recipients=overrideTo; }
    else {
      const { data: recs } = await supabase.from("general_recipients").select("email").eq("active",true);
      recipients=(recs||[]).map((r:any)=>r.email).filter(Boolean);
    }
    if(!recipients.length){ await logError(reportDate,"no active general recipients"); return new Response(JSON.stringify({skipped:true,reason:"no active general recipients"}),{status:200}); }

    stage="send";
    const subject=(preview?"[PREVIEW] ":"")+`Weekly Workload — ${prettyDate}`;
    const r=await sendEmail(settings,recipients,subject,html,pdfB64,pdfName);
    if(!preview){
      if(r.ok) await supabase.from("send_log").upsert({kind:"general_report",run_date:reportDate,detail:r.detail},{onConflict:"kind,run_date"});
      else await logError(reportDate,"send failed: "+r.detail);
    }
    return new Response(JSON.stringify({ok:r.ok,preview,signature:!!settings.email_signature,reportDate,departments:groups.map(g=>`${g.dept}:${g.rows.length}`),to:recipients,detail:r.detail}),{headers:{"Content-Type":"application/json"}});
  } catch(e){
    await logError(runDate||new Date().toISOString().slice(0,10),`crashed at ${stage}: ${String(e)}`);
    return new Response(JSON.stringify({error:String(e),stage}),{status:500});
  }
});
