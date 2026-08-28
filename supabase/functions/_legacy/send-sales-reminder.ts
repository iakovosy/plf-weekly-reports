// Tuesday 17:00 reminder for SALES: emails only Sales admins who haven't submitted this week.
import { createClient } from "jsr:@supabase/supabase-js@2";
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
function cyprusNow(){const p=new Intl.DateTimeFormat("en-GB",{timeZone:"Asia/Nicosia",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",weekday:"short",hour12:false}).formatToParts(new Date());const g=(t:string)=>p.find(x=>x.type===t)?.value??"";return{date:`${g("year")}-${g("month")}-${g("day")}`,hour:parseInt(g("hour"),10),weekday:g("weekday")};}
async function getSettings(){const{data,error}=await supabase.from("portal_settings").select("key,value");if(error)throw error;return Object.fromEntries(data.map((r:any)=>[r.key,r.value]));}
function parseFrom(from:string){const m=from.match(/^(.*)<([^>]+)>\s*$/);if(m)return{name:m[1].trim().replace(/^"|"$/g,"")||undefined,email:m[2].trim()};return{email:from.trim()};}
async function sendEmail(settings:Record<string,string>,to:string,subject:string,html:string){
  const from=settings.from_email||"PLF Reports <onboarding@resend.dev>";const brevoKey=settings.brevo_api_key;
  if(brevoKey){const f=parseFrom(from);const resp=await fetch("https://api.brevo.com/v3/smtp/email",{method:"POST",headers:{"Content-Type":"application/json","api-key":brevoKey},body:JSON.stringify({sender:{email:f.email,name:f.name??"PLF Reports"},to:[{email:to}],subject,htmlContent:html})});return{ok:resp.ok,detail:resp.ok?null:await resp.text()};}
  const resendKey=Deno.env.get("RESEND_API_KEY")||settings.resend_api_key;if(!resendKey)return{ok:false,detail:"No provider"};
  const resp=await fetch("https://api.resend.com/emails",{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${resendKey}`},body:JSON.stringify({from,to:[to],subject,html})});
  return{ok:resp.ok,detail:resp.ok?null:await resp.text()};
}
const BLUE="#4F75FF",AMBER="#F7C135";
function buildReminder(name:string,link:string,prettyDate:string){
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#F2F2F2">
  <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">Reminder: your Sales report (${prettyDate}) is due today at 17:30.&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F2F2F2"><tr><td align="center" style="padding:24px 12px">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:560px;max-width:100%">
      <tr><td bgcolor="${BLUE}" style="background-color:${BLUE};padding:24px 28px">
        <div style="font-family:Arial,Helvetica,sans-serif;color:#EAF0FF;font-size:11px;letter-spacing:3px;font-weight:bold">PHILIPPOU LAW FIRM</div>
        <div style="font-family:Arial,Helvetica,sans-serif;color:#ffffff;font-size:20px;font-weight:bold;padding-top:6px">Reminder — Sales Weekly Report</div>
      </td></tr>
      <tr><td bgcolor="#ffffff" style="background-color:#ffffff;padding:26px 28px;border-left:1px solid #E2DDD9;border-right:1px solid #E2DDD9;border-bottom:1px solid #E2DDD9;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#101418;line-height:1.5">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#FFF7E0" style="background-color:#FFF7E0;border-left:4px solid ${AMBER};padding:12px 14px;font-size:13px;color:#7a5b00">This is a friendly reminder — your Sales report for this week hasn't been submitted yet.</td></tr></table>
        <p style="margin:16px 0 14px">Dear ${name},</p>
        <p style="margin:0 0 14px">Please complete this week's Sales report before <strong style="color:${BLUE}">today, 17:30</strong>. It only takes a minute.</p>
        <p style="margin:0 0 14px">The consolidated results are reviewed at the weekly Sales meeting on <strong>Wednesday at 08:30</strong>.</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:24px 0 26px">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${BLUE}" style="background-color:${BLUE};border-radius:8px;padding:14px 38px" align="center">
            <a href="${link}" target="_blank" style="font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none"><span style="color:#ffffff">Complete Sales report</span></a>
          </td></tr></table>
        </td></tr></table>
        <p style="font-size:12px;color:#888888;margin:0">If the button doesn't work, copy this link:<br><a href="${link}" style="color:${BLUE}">${link}</a></p>
      </td></tr>
      <tr><td align="center" style="padding:14px;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#B3B3B3">All Rights Reserved © Philippou Law Firm</td></tr>
    </table>
  </td></tr></table></body></html>`;
}
Deno.serve(async (req) => {
  try {
    const settings = await getSettings();
    if (req.headers.get("x-cron-secret") !== settings.cron_secret) return new Response(JSON.stringify({error:"unauthorized"}),{status:401});
    const body = await req.json().catch(()=>({}));
    const force = body.force === true;
    const now = cyprusNow();
    const portalUrl=(settings.portal_url||"").replace(/\/$/,"");
    const salesFormUrl=`${portalUrl}/sales.html`;
    const schedDay = settings.sales_reminder_day||"Tue";
    const schedHour = parseInt(settings.sales_reminder_hour??"17",10);
    if(!force && !(now.weekday===schedDay && now.hour===schedHour)) return new Response(JSON.stringify({skipped:true,reason:"outside schedule window",now}),{status:200});

    const { data: formsLog } = await supabase.from("send_log").select("id").eq("kind","sales_forms").eq("run_date",now.date).maybeSingle();
    if(!formsLog && !force) return new Response(JSON.stringify({skipped:true,reason:"no sales forms sent today"}),{status:200});

    let reportDate = now.date;
    const { data: todays } = await supabase.from("sales_submissions").select("id").eq("report_date",now.date).limit(1);
    if(!todays?.length){
      const { data: latest } = await supabase.from("sales_submissions").select("report_date").order("report_date",{ascending:false}).limit(1);
      if(!latest?.length) return new Response(JSON.stringify({skipped:true,reason:"no rows"}),{status:200});
      reportDate = latest[0].report_date as string;
    }
    const { data: remLog } = await supabase.from("send_log").select("id").eq("kind","sales_reminder").eq("run_date",reportDate).maybeSingle();
    if(remLog && !force) return new Response(JSON.stringify({skipped:true,reason:"reminder already sent"}),{status:200});

    const { data: pending } = await supabase.from("sales_submissions").select("token, sales_admins!inner(name,email,active)").eq("report_date",reportDate).eq("status","pending");
    const targets = (pending||[]).filter((r:any)=>r.sales_admins?.active);
    if(!targets.length){
      await supabase.from("send_log").upsert({kind:"sales_reminder",run_date:reportDate,detail:"no non-submitters"},{onConflict:"kind,run_date"});
      return new Response(JSON.stringify({ok:true,reportDate,sent:0,reason:"everyone submitted"}),{headers:{"Content-Type":"application/json"}});
    }
    const [yy,mm,dd]=reportDate.split("-");const prettyDate=`${dd}/${mm}/${yy}`;
    const results:any[]=[];
    for(const t of targets){
      const link=`${salesFormUrl}?token=${t.token}`;
      const r=await sendEmail(settings,t.sales_admins.email,`Reminder — Sales Weekly Report due today 17:30 — ${prettyDate}`,buildReminder(t.sales_admins.name,link,prettyDate));
      results.push({email:t.sales_admins.email,...r});
    }
    await supabase.from("send_log").upsert({kind:"sales_reminder",run_date:reportDate,detail:JSON.stringify(results)},{onConflict:"kind,run_date"});
    return new Response(JSON.stringify({ok:true,reportDate,sent:results.length}),{headers:{"Content-Type":"application/json"}});
  } catch(e){ return new Response(JSON.stringify({error:String(e)}),{status:500}); }
});
