"use client";

import { useState, useEffect, useRef, useCallback } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────
interface ToolCall { id: string; tool_name: string; tool_args: Record<string,unknown>; status:"pending"|"approved"|"rejected"|"executed"|"failed"; result?: unknown; error?: string; requested_at: string; executed_at?: string; }
interface TimelineEvent { id: string; timestamp: string; type:"thinking"|"tool_call"|"observation"|"hypothesis"|"conclusion"; title: string; description: string; tool_call?: ToolCall; data?: unknown; }
interface Evidence { id: string; type:"log"|"metric"|"deployment"|"commit"|"query_result"|"process"|"network"; source: string; title: string; content: unknown; relevance:"critical"|"high"|"medium"|"low"; timestamp: string; }
interface FixStep { step: number; title: string; urgency:"do_now"|"do_today"|"do_this_week"; description: string; commands?: string[]; expected_outcome?: string; risk?: string; }
interface SuggestedFix { title: string; description: string; priority:"immediate"|"short_term"|"long_term"; effort:"low"|"medium"|"high"; commands?: string[]; risk:"safe"|"medium"|"high"; }
interface RootCauseReport { summary: string; root_cause: string; contributing_factors: string[]; confidence: number; severity:"critical"|"high"|"medium"|"low"; suggested_fixes: SuggestedFix[]; step_by_step_fix?: FixStep[]; immediate_actions: string[]; next_steps: string[]; timeline_of_events: string[]; postmortem_notes: string; monitoring_after_fix?: string[]; }
interface Investigation { id: string; incident_description: string; status:"running"|"waiting_approval"|"completed"|"failed"; created_at: string; updated_at: string; timeline: TimelineEvent[]; evidence: Evidence[]; pending_tool_call?: ToolCall; report?: RootCauseReport; }
interface Chat { id: string; title: string; created_at: string; investigations: Investigation[]; lastMessage: string; }
type NavView = "chat"|"history"|"patterns";
type MainPanel = "timeline"|"evidence"|"report";

const chatStore: Chat[] = [];

const SEV: Record<string,string> = { critical:"#ef4444", high:"#f97316", medium:"#eab308", low:"#22c55e" };
const URG: Record<string,{label:string;color:string}> = { do_now:{label:"Do Now",color:"#ef4444"}, do_today:{label:"Do Today",color:"#f97316"}, do_this_week:{label:"This Week",color:"#3b82f6"} };
const EV_META: Record<string,{icon:string;color:string}> = { thinking:{icon:"◈",color:"#6366f1"}, tool_call:{icon:"⬡",color:"#3b82f6"}, observation:{icon:"◉",color:"#eab308"}, hypothesis:{icon:"◆",color:"#a855f7"}, conclusion:{icon:"✦",color:"#22c55e"} };

function rt(ts: string) { const d = Date.now()-new Date(ts).getTime(); if(d<60000) return `${Math.floor(d/1000)}s ago`; if(d<3600000) return `${Math.floor(d/60000)}m ago`; return new Date(ts).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}); }

function CopyBtn({text}:{text:string}) {
  const [c,setC]=useState(false);
  return <button onClick={()=>{navigator.clipboard.writeText(text).catch(()=>{});setC(true);setTimeout(()=>setC(false),1500)}} style={{padding:"2px 8px",borderRadius:4,border:"1px solid var(--border-2)",background:"var(--bg-2)",color:c?"var(--green)":"var(--text-3)",fontSize:10,cursor:"pointer",fontFamily:"var(--mono)",transition:"all .15s"}}>{c?"Copied!":"Copy"}</button>;
}

function createMock(q: string): Investigation {
  const now=Date.now(); const ts=(o:number)=>new Date(now-o).toISOString();
  return { id:"inv-"+Math.random().toString(36).slice(2,8), incident_description:q, status:"waiting_approval", created_at:ts(4*60000), updated_at:ts(0),
    timeline:[
      {id:"t1",timestamp:ts(4*60000),type:"thinking",title:"Investigation Started",description:"Parsing incident and forming hypotheses. Could be DB connection exhaustion, OOM, or bad deploy."},
      {id:"t2",timestamp:ts(3.5*60000),type:"tool_call",title:"Requesting: get_error_logs",description:"Fetching error logs for service",tool_call:{id:"tc1",tool_name:"get_error_logs",tool_args:{service:"api",last_minutes:30},status:"executed",requested_at:ts(3.5*60000)}},
      {id:"t3",timestamp:ts(3*60000),type:"observation",title:"Critical: DB Connection Errors",description:"47x asyncpg.TooManyConnectionsError — PostgreSQL is out of connections."},
      {id:"t4",timestamp:ts(2.5*60000),type:"tool_call",title:"Requesting: check_db_connections",description:"Verifying PostgreSQL pool status",tool_call:{id:"tc2",tool_name:"check_db_connections",tool_args:{database_type:"postgresql"},status:"executed",requested_at:ts(2.5*60000)}},
      {id:"t5",timestamp:ts(2*60000),type:"hypothesis",title:"Hypothesis: Pool Exhausted",description:"PostgreSQL at 94/100 connections, 12 idle-in-transaction — connection leak from recent deploy."},
      {id:"t6",timestamp:ts(1.5*60000),type:"tool_call",title:"Requesting: get_github_commits",description:"Checking deploy correlation",tool_call:{id:"tc3",tool_name:"get_github_commits",tool_args:{last_n:5},status:"executed",requested_at:ts(1.5*60000)}},
      {id:"t7",timestamp:ts(60000),type:"observation",title:"Deploy Correlation Found",description:"v2.4.7 deployed 28 minutes ago. Modified db/connection.py. Errors started 3 minutes after."},
    ],
    evidence:[
      {id:"e1",type:"log",source:"get_error_logs",title:"Error Log Analysis",content:{error_count:47,top_error:"asyncpg.TooManyConnectionsError"},relevance:"critical",timestamp:ts(3*60000)},
      {id:"e2",type:"query_result",source:"check_db_connections",title:"PostgreSQL Connections",content:{max:100,current:94,idle_in_tx:12,usage_pct:"94%"},relevance:"critical",timestamp:ts(2*60000)},
      {id:"e3",type:"deployment",source:"get_github_commits",title:"Recent Deploy",content:{version:"v2.4.7",changed:["db/connection.py"],by:"jane.doe",mins_ago:28},relevance:"critical",timestamp:ts(1.5*60000)},
      {id:"e4",type:"metric",source:"check_memory_usage",title:"Memory",content:{used_pct:"73%",status:"normal"},relevance:"low",timestamp:ts(2.8*60000)},
    ],
    pending_tool_call:{id:"tcp-"+Math.random().toString(36).slice(2,6),tool_name:"get_slow_queries",tool_args:{database_type:"postgresql",threshold_ms:1000},status:"pending",requested_at:ts(30000)},
    report:{
      summary:"PostgreSQL connection pool exhausted after v2.4.7 changed pool settings",
      root_cause:"PR #847 reduced max pool size 20→5 per worker. With 4 workers = 20 total connections. Missing async context manager leaks 12 idle-in-transaction connections causing cascading failures.",
      contributing_factors:["Pool max silently reduced from 20→5 per worker","12 connections leaked (missing context manager)","No connection timeout configured","max_connections=100 too low for current load"],
      confidence:91, severity:"critical",
      step_by_step_fix:[
        {step:1,title:"Rollback v2.4.7 immediately",urgency:"do_now",description:"Revert to v2.4.6 to restore service while root cause is fixed properly.",commands:["pm2 deploy ecosystem.config.js production revert","pm2 status  # verify workers online"],expected_outcome:"Service restored in ~60 seconds",risk:"Low — reverting to known-good version"},
        {step:2,title:"Kill leaked connections",urgency:"do_now",description:"Terminate idle-in-transaction sessions > 2 minutes old.",commands:["-- Run in psql:","SELECT pg_terminate_backend(pid) FROM pg_stat_activity","WHERE state = 'idle in transaction'","AND query_start < now() - interval '2 minutes';"],expected_outcome:"Frees ~12 connections, errors stop",risk:"Safe — only terminates idle sessions"},
        {step:3,title:"Fix pool config in code",urgency:"do_today",description:"Restore max_pool_size=20 and wrap DB calls in async context managers.",commands:["git revert a3f9b2c","# Ensure: async with pool.acquire() as conn:","git push origin main"],expected_outcome:"Permanent fix for the connection leak",risk:"Low — reverting config change"},
        {step:4,title:"Add connection monitoring",urgency:"do_this_week",description:"Alert when connections exceed 75% of max_connections.",commands:["# Prometheus alert rule:","expr: pg_stat_activity_count > 75","for: 1m"],expected_outcome:"Early warning before next incident",risk:"None — read-only monitoring"},
      ],
      suggested_fixes:[],
      immediate_actions:["pm2 deploy ecosystem.config.js production revert","Kill idle-in-transaction connections older than 2 min"],
      next_steps:["Add connection pool dashboard","Require pool config review in PR checklist"],
      timeline_of_events:["13:58 — v2.4.7 deployed (PR #847, jane.doe)","14:01 — DB connections climb 45→80","14:03 — First 500 errors appear","14:07 — Connections hit 94/100, cascading failures","14:15 — PagerDuty alert, incident declared"],
      postmortem_notes:"Pool config change was under-reviewed. PR had 2 approvals but neither reviewer caught the reduced pool size.",
      monitoring_after_fix:["Run check_db_connections every 5 min for 1 hour","Watch error rate with: tail_logs api 50"],
    }
  };
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────
function Sidebar({chats,activeChatId,navView,onNew,onNav,onSelectChat,open,setOpen}:{chats:Chat[];activeChatId:string|null;navView:NavView;onNew:()=>void;onNav:(v:NavView)=>void;onSelectChat:(c:Chat)=>void;open:boolean;setOpen:(v:boolean)=>void}) {
  return (
    <>
      {open && <div onClick={()=>setOpen(false)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,.55)",zIndex:40}} className="mob-overlay"/>}
      <aside className={`sidebar${open?" sidebar-open":""}`} style={{width:232,background:"var(--bg-1)",borderRight:"1px solid var(--border)",display:"flex",flexDirection:"column",height:"100vh",flexShrink:0,zIndex:41}}>
        <div style={{padding:"14px 14px 10px",borderBottom:"1px solid var(--border)",flexShrink:0}}>
          <div style={{display:"flex",alignItems:"center",gap:9,marginBottom:12}}>
            <div style={{width:30,height:30,borderRadius:7,background:"linear-gradient(135deg,#312e81,#4f46e5)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,flexShrink:0}}>⬡</div>
            <div style={{flex:1}}>
              <div style={{fontSize:12,fontWeight:700,color:"var(--text)",letterSpacing:"-.02em"}}>DevOps AI</div>
              <div style={{fontSize:9,color:"var(--text-4)",fontFamily:"var(--mono)",letterSpacing:".07em"}}>INVESTIGATOR</div>
            </div>
            <button onClick={()=>setOpen(false)} className="close-sb" style={{background:"none",border:"none",color:"var(--text-3)",fontSize:15,display:"none",padding:"2px 4px"}}>✕</button>
          </div>
          <button onClick={onNew} style={{width:"100%",padding:"7px 11px",borderRadius:7,border:"1px solid var(--border-2)",background:"transparent",color:"var(--text-2)",fontSize:12,fontWeight:500,cursor:"pointer",display:"flex",alignItems:"center",gap:7,fontFamily:"var(--font)"}}>
            <span style={{color:"var(--accent-2)",fontSize:13}}>+</span> New investigation
          </button>
        </div>
        <div style={{padding:"6px 7px",borderBottom:"1px solid var(--border)",flexShrink:0}}>
          {(["chat","history","patterns"] as NavView[]).map((id,i)=>{
            const icons=["⬡","◷","◈"]; const labels=["Investigate","History","Patterns"];
            return <button key={id} onClick={()=>{onNav(id);setOpen(false)}} style={{display:"flex",alignItems:"center",gap:8,width:"100%",padding:"6px 9px",borderRadius:6,border:"none",cursor:"pointer",background:navView===id?"rgba(99,102,241,.1)":"transparent",color:navView===id?"var(--accent-2)":"var(--text-3)",fontSize:12,fontWeight:navView===id?500:400,textAlign:"left",marginBottom:1,fontFamily:"var(--font)"}}>
              <span style={{fontSize:11,opacity:.8}}>{icons[i]}</span>{labels[i]}
            </button>;
          })}
        </div>
        <div style={{flex:1,overflow:"auto",padding:"5px 7px"}}>
          {chats.length===0?(
            <div style={{padding:"10px 6px"}}>
              <div style={{fontSize:9,color:"var(--text-4)",fontFamily:"var(--mono)",padding:"3px 5px 8px",letterSpacing:".08em",textTransform:"uppercase"}}>Examples</div>
              {["Why are we getting 500 errors?","Is any EC2 running?","Check all database health","Why did last deploy fail?"].map((q,i)=>(
                <button key={i} onClick={()=>{onNav("chat");}} style={{display:"block",width:"100%",padding:"5px 7px",borderRadius:5,border:"none",cursor:"pointer",background:"transparent",color:"var(--text-4)",fontSize:11,textAlign:"left",lineHeight:1.5,marginBottom:2,fontFamily:"var(--font)"}}>{q}</button>
              ))}
            </div>
          ):(
            <div style={{padding:"3px 0"}}>
              <div style={{fontSize:9,color:"var(--text-4)",fontFamily:"var(--mono)",padding:"3px 9px 7px",letterSpacing:".08em",textTransform:"uppercase"}}>Recent</div>
              {[...chats].reverse().map(chat=>{
                const sev=chat.investigations[chat.investigations.length-1]?.report?.severity;
                return <button key={chat.id} onClick={()=>{onSelectChat(chat);setOpen(false)}} style={{display:"block",width:"100%",padding:"7px 9px",borderRadius:6,border:"none",cursor:"pointer",background:activeChatId===chat.id?"rgba(99,102,241,.08)":"transparent",color:activeChatId===chat.id?"var(--text)":"var(--text-2)",fontSize:11,textAlign:"left",lineHeight:1.4,marginBottom:1,fontFamily:"var(--font)",borderLeft:activeChatId===chat.id?"2px solid var(--accent)":"2px solid transparent"}}>
                  <div style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",marginBottom:2}}>{chat.title}</div>
                  <div style={{display:"flex",gap:5,alignItems:"center"}}>
                    <span style={{fontSize:9,color:"var(--text-4)",fontFamily:"var(--mono)"}}>{new Date(chat.created_at).toLocaleDateString()}</span>
                    {sev&&<span style={{fontSize:8,padding:"1px 4px",borderRadius:3,background:`${SEV[sev]}15`,color:SEV[sev],fontFamily:"var(--mono)",fontWeight:700}}>{sev}</span>}
                  </div>
                </button>;
              })}
            </div>
          )}
        </div>
        <div style={{padding:"9px 13px",borderTop:"1px solid var(--border)",flexShrink:0}}>
          {[["Agent","online"],["MCP Server","online"],["Read-Only","on"]].map(([l,s])=>(
            <div key={l} style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}>
              <span style={{fontSize:10,color:"var(--text-4)"}}>{l}</span>
              <span style={{fontSize:8,padding:"1px 5px",borderRadius:3,background:"rgba(34,197,94,.1)",color:"var(--green)",fontFamily:"var(--mono)",fontWeight:600}}>{s}</span>
            </div>
          ))}
        </div>
      </aside>
    </>
  );
}

// ─── Timeline Item ────────────────────────────────────────────────────────────
function TLItem({event,index}:{event:TimelineEvent;index:number}) {
  const [exp,setExp]=useState(false);
  const m=EV_META[event.type]||EV_META.thinking;
  return (
    <div style={{display:"flex",gap:11,paddingBottom:18,animation:`slideIn .22s ease-out ${index*.04}s both`}}>
      <div style={{display:"flex",flexDirection:"column",alignItems:"center",flexShrink:0,paddingTop:2}}>
        <div style={{width:26,height:26,borderRadius:"50%",background:`${m.color}12`,border:`1.5px solid ${m.color}28`,display:"flex",alignItems:"center",justifyContent:"center",color:m.color,fontSize:10,fontWeight:700}}>{m.icon}</div>
        <div style={{width:1,flex:1,background:"var(--border)",marginTop:4,minHeight:14}}/>
      </div>
      <div style={{flex:1,minWidth:0,paddingTop:2}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8,marginBottom:2}}>
          <span style={{fontSize:12,fontWeight:600,color:m.color,lineHeight:1.3}}>{event.title}</span>
          <span style={{fontSize:9,color:"var(--text-4)",fontFamily:"var(--mono)",flexShrink:0}}>{rt(event.timestamp)}</span>
        </div>
        <p style={{fontSize:12,color:"var(--text-2)",lineHeight:1.6,margin:0}}>{event.description}</p>
        {event.tool_call&&<div style={{marginTop:7,padding:"5px 9px",borderRadius:5,background:"var(--bg-3)",border:"1px solid var(--border)",display:"inline-flex",alignItems:"center",gap:6}}>
          <span style={{fontSize:9,fontFamily:"var(--mono)",color:"var(--text-3)"}}>tool</span>
          <span style={{fontSize:10,fontFamily:"var(--mono)",color:"var(--accent-2)",fontWeight:600}}>{event.tool_call.tool_name}</span>
          <span style={{width:5,height:5,borderRadius:"50%",background:event.tool_call.status==="executed"?"var(--green)":event.tool_call.status==="failed"?"var(--red)":"var(--yellow)",flexShrink:0}}/>
        </div>}
        {event.data&&<><button onClick={()=>setExp(!exp)} style={{marginTop:5,fontSize:9,color:"var(--accent-2)",background:"none",border:"none",cursor:"pointer",padding:0,fontFamily:"var(--mono)"}}>{exp?"▲ hide":"▼ data"}</button>{exp&&<pre style={{marginTop:5,padding:9,background:"var(--bg)",borderRadius:6,border:"1px solid var(--border)",fontSize:9,color:"var(--text-2)",overflow:"auto",maxHeight:180,fontFamily:"var(--mono)"}}>{JSON.stringify(event.data,null,2)}</pre>}</>}
      </div>
    </div>
  );
}

// ─── Evidence Card ────────────────────────────────────────────────────────────
function EvCard({ev}:{ev:Evidence}) {
  const [exp,setExp]=useState(false);
  const c=SEV[ev.relevance]||"#52525b";
  const icons:Record<string,string>={log:"≡",metric:"◈",deployment:"↑",commit:"◇",query_result:"⬡",process:"◉",network:"⟳"};
  return (
    <div style={{background:"var(--bg-2)",border:"1px solid var(--border)",borderRadius:9,borderLeft:`3px solid ${c}`,padding:13,marginBottom:7,animation:"fadeUp .2s ease-out"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:5,gap:8}}>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <span style={{width:20,height:20,borderRadius:4,background:`${c}15`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,color:c,flexShrink:0}}>{icons[ev.type]||"◈"}</span>
          <span style={{fontSize:12,fontWeight:600,color:"var(--text)"}}>{ev.title}</span>
        </div>
        <span style={{fontSize:8,padding:"2px 6px",borderRadius:3,background:`${c}12`,color:c,fontWeight:700,fontFamily:"var(--mono)",textTransform:"uppercase",flexShrink:0}}>{ev.relevance}</span>
      </div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <span style={{fontSize:9,color:"var(--text-4)",fontFamily:"var(--mono)"}}>{ev.source}</span>
        <button onClick={()=>setExp(!exp)} style={{fontSize:9,color:"var(--accent-2)",background:"none",border:"none",cursor:"pointer",padding:0,fontFamily:"var(--mono)"}}>{exp?"▲ collapse":"▼ expand"}</button>
      </div>
      {exp&&<pre style={{marginTop:9,padding:9,background:"var(--bg)",borderRadius:6,border:"1px solid var(--border)",fontSize:9,color:"var(--text-2)",overflow:"auto",maxHeight:260,fontFamily:"var(--mono)"}}>{JSON.stringify(ev.content,null,2)}</pre>}
    </div>
  );
}

// ─── Tool Approval ────────────────────────────────────────────────────────────
function ToolApproval({tc,onA,onR}:{tc:ToolCall;onA:()=>void;onR:()=>void}) {
  return (
    <div style={{background:"var(--bg-2)",border:"1px solid rgba(99,102,241,.32)",borderRadius:11,padding:16,marginBottom:18,animation:"fadeUp .22s ease-out",boxShadow:"0 0 28px rgba(99,102,241,.07)"}}>
      <div style={{display:"flex",alignItems:"center",gap:9,marginBottom:12}}>
        <div style={{width:30,height:30,borderRadius:"50%",background:"rgba(99,102,241,.1)",border:"1.5px solid rgba(99,102,241,.22)",display:"flex",alignItems:"center",justifyContent:"center",color:"var(--accent-2)",fontSize:11,fontWeight:700}}>AI</div>
        <div><div style={{fontSize:12,fontWeight:600,color:"var(--text)"}}>Tool execution requested</div><div style={{fontSize:10,color:"var(--text-3)"}}>Approve to continue</div></div>
      </div>
      <div style={{background:"var(--bg)",border:"1px solid var(--border)",borderRadius:7,padding:12,marginBottom:12}}>
        <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:8}}>
          <span style={{fontSize:9,color:"var(--text-4)",fontFamily:"var(--mono)",textTransform:"uppercase",letterSpacing:".07em"}}>Tool</span>
          <span style={{fontSize:12,fontFamily:"var(--mono)",color:"var(--accent-2)",fontWeight:600}}>{tc.tool_name}</span>
        </div>
        <div style={{fontSize:9,color:"var(--text-4)",fontFamily:"var(--mono)",textTransform:"uppercase",letterSpacing:".07em",marginBottom:5}}>Args</div>
        <pre style={{fontSize:10,color:"var(--text-2)",fontFamily:"var(--mono)",margin:0,whiteSpace:"pre-wrap"}}>{JSON.stringify(tc.tool_args,null,2)}</pre>
      </div>
      <div style={{display:"flex",gap:7}}>
        <button onClick={onA} style={{flex:1,padding:"9px 0",borderRadius:7,cursor:"pointer",background:"rgba(34,197,94,.08)",border:"1px solid rgba(34,197,94,.25)",color:"var(--green)",fontWeight:600,fontSize:12,fontFamily:"var(--font)"}}>✓ Approve</button>
        <button onClick={onR} style={{flex:1,padding:"9px 0",borderRadius:7,cursor:"pointer",background:"transparent",border:"1px solid var(--border-2)",color:"var(--text-3)",fontWeight:600,fontSize:12,fontFamily:"var(--font)"}}>✕ Reject</button>
      </div>
    </div>
  );
}

// ─── Fix Plan ─────────────────────────────────────────────────────────────────
function FixPlan({steps,imm}:{steps:FixStep[];imm:string[]}) {
  const [done,setDone]=useState<Set<number>>(new Set());
  const tog=(n:number)=>setDone(p=>{const s=new Set(p);s.has(n)?s.delete(n):s.add(n);return s;});
  return (
    <div style={{animation:"fadeUp .2s ease-out"}}>
      {imm.length>0&&<div style={{background:"rgba(239,68,68,.05)",border:"1px solid rgba(239,68,68,.18)",borderRadius:9,padding:13,marginBottom:14}}>
        <div style={{fontSize:10,fontFamily:"var(--mono)",color:"var(--red)",fontWeight:600,letterSpacing:".07em",marginBottom:7}}>⚠ IMMEDIATE ACTIONS</div>
        {imm.map((a,i)=><div key={i} style={{display:"flex",gap:7,marginBottom:3,fontSize:12,color:"var(--text-2)"}}><span style={{color:"var(--red)",fontWeight:700,flexShrink:0}}>{i+1}.</span>{a}</div>)}
      </div>}
      {steps.map(step=>{
        const d=done.has(step.step); const u=URG[step.urgency]||URG.do_this_week;
        return (
          <div key={step.step} style={{background:d?"rgba(34,197,94,.04)":"var(--bg-2)",border:`1px solid ${d?"rgba(34,197,94,.18)":"var(--border)"}`,borderRadius:9,padding:14,marginBottom:9,opacity:d?.6:1,transition:"all .2s"}}>
            <div style={{display:"flex",alignItems:"flex-start",gap:10}}>
              <button onClick={()=>tog(step.step)} style={{width:20,height:20,borderRadius:"50%",border:`2px solid ${d?"var(--green)":"var(--border-2)"}`,background:d?"var(--green)":"transparent",color:d?"#000":"transparent",fontSize:9,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,marginTop:1,transition:"all .15s",fontWeight:700}}>✓</button>
              <div style={{flex:1,minWidth:0}}>
                <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:3,flexWrap:"wrap"}}>
                  <span style={{fontSize:9,fontFamily:"var(--mono)",color:"var(--text-4)"}}>Step {step.step}</span>
                  <span style={{fontSize:12,fontWeight:600,color:d?"var(--text-3)":"var(--text)",textDecoration:d?"line-through":"none"}}>{step.title}</span>
                  <span style={{fontSize:8,padding:"2px 6px",borderRadius:3,background:`${u.color}12`,color:u.color,fontFamily:"var(--mono)",fontWeight:700,flexShrink:0}}>{u.label}</span>
                </div>
                <p style={{fontSize:11,color:"var(--text-2)",lineHeight:1.6,margin:"0 0 9px"}}>{step.description}</p>
                {step.commands&&step.commands.length>0&&<div style={{position:"relative"}}>
                  <div style={{position:"absolute",top:7,right:7,zIndex:1}}><CopyBtn text={step.commands.join("\n")}/></div>
                  <pre style={{background:"var(--bg)",border:"1px solid var(--border)",borderRadius:6,padding:"9px 13px",fontSize:10,color:"var(--text-2)",fontFamily:"var(--mono)",margin:0,overflow:"auto",lineHeight:1.6}}>{step.commands.join("\n")}</pre>
                </div>}
                {step.expected_outcome&&<div style={{marginTop:7,fontSize:10,color:"var(--green)",display:"flex",gap:5}}>→ {step.expected_outcome}</div>}
                {step.risk&&<div style={{marginTop:3,fontSize:9,color:"var(--text-4)",fontFamily:"var(--mono)"}}>Risk: {step.risk}</div>}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Report ───────────────────────────────────────────────────────────────────
function Report({report}:{report:RootCauseReport}) {
  const [tab,setTab]=useState<"overview"|"fix"|"timeline">(report.step_by_step_fix?.length?"fix":"overview");
  const sc=SEV[report.severity]||"#52525b";
  return (
    <div style={{animation:"fadeUp .22s ease-out"}}>
      <div style={{background:"var(--bg-2)",border:`1px solid ${sc}28`,borderRadius:11,padding:16,marginBottom:14}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:10}}>
          <div style={{flex:1,minWidth:0}}>
            <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:5}}>
              <span style={{fontSize:8,padding:"2px 7px",borderRadius:3,background:`${sc}15`,color:sc,fontFamily:"var(--mono)",fontWeight:700,textTransform:"uppercase"}}>{report.severity}</span>
              <span style={{fontSize:10,color:"var(--text-3)",fontFamily:"var(--mono)"}}>root cause identified</span>
            </div>
            <div style={{fontSize:14,fontWeight:700,color:"var(--text)",lineHeight:1.4}}>{report.summary}</div>
          </div>
          <div style={{textAlign:"right",flexShrink:0}}>
            <div style={{fontSize:9,color:"var(--text-4)",fontFamily:"var(--mono)",marginBottom:1}}>Confidence</div>
            <div style={{fontSize:28,fontWeight:800,color:report.confidence>80?"var(--green)":"var(--yellow)",fontFamily:"var(--mono)",lineHeight:1}}>{report.confidence}%</div>
          </div>
        </div>
      </div>
      <div style={{display:"flex",gap:2,marginBottom:14,background:"var(--bg-2)",border:"1px solid var(--border)",borderRadius:8,padding:3}}>
        {(["overview","fix","timeline"] as const).map((t,i)=>{
          const labels=["Root Cause",`Fix Plan (${report.step_by_step_fix?.length||report.suggested_fixes.length})`,"Timeline"];
          return <button key={t} onClick={()=>setTab(t)} style={{flex:1,padding:"6px 10px",borderRadius:5,border:"none",cursor:"pointer",background:tab===t?"var(--bg-3)":"transparent",color:tab===t?"var(--text)":"var(--text-3)",fontWeight:tab===t?600:400,fontSize:11,fontFamily:"var(--font)"}}>{labels[i]}</button>;
        })}
      </div>
      {tab==="overview"&&<div>
        <div style={{background:"var(--bg-2)",border:"1px solid var(--border)",borderRadius:9,padding:14,marginBottom:9}}>
          <div style={{fontSize:9,color:"var(--text-4)",fontFamily:"var(--mono)",letterSpacing:".07em",textTransform:"uppercase",marginBottom:7}}>Root Cause</div>
          <p style={{fontSize:12,color:"var(--text-2)",lineHeight:1.7,margin:0}}>{report.root_cause}</p>
        </div>
        <div style={{background:"var(--bg-2)",border:"1px solid var(--border)",borderRadius:9,padding:14,marginBottom:9}}>
          <div style={{fontSize:9,color:"var(--text-4)",fontFamily:"var(--mono)",letterSpacing:".07em",textTransform:"uppercase",marginBottom:9}}>Contributing Factors</div>
          {report.contributing_factors.map((f,i)=><div key={i} style={{display:"flex",gap:7,marginBottom:6,fontSize:12,color:"var(--text-2)"}}><span style={{color:"var(--orange)",flexShrink:0,fontWeight:700}}>→</span>{f}</div>)}
        </div>
        {report.monitoring_after_fix&&report.monitoring_after_fix.length>0&&<div style={{background:"var(--bg-2)",border:"1px solid var(--border)",borderRadius:9,padding:14}}>
          <div style={{fontSize:9,color:"var(--text-4)",fontFamily:"var(--mono)",letterSpacing:".07em",textTransform:"uppercase",marginBottom:7}}>Monitor After Fix</div>
          {report.monitoring_after_fix.map((m,i)=><div key={i} style={{display:"flex",gap:7,marginBottom:3,fontSize:11,color:"var(--text-2)"}}><span style={{color:"var(--blue)",flexShrink:0}}>◈</span>{m}</div>)}
        </div>}
      </div>}
      {tab==="fix"&&(report.step_by_step_fix?.length?<FixPlan steps={report.step_by_step_fix} imm={report.immediate_actions}/>:<div>
        {report.suggested_fixes.map((fix,i)=>{
          const pc:Record<string,string>={immediate:"var(--red)",short_term:"var(--orange)",long_term:"var(--blue)"};
          const c=pc[fix.priority]||"var(--text-3)";
          return <div key={i} style={{background:"var(--bg-2)",border:"1px solid var(--border)",borderRadius:9,borderLeft:`3px solid ${c}`,padding:14,marginBottom:9}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:7,gap:8,flexWrap:"wrap"}}>
              <span style={{fontSize:13,fontWeight:600,color:"var(--text)"}}>{fix.title}</span>
              <span style={{fontSize:8,padding:"2px 6px",borderRadius:3,background:`${c}12`,color:c,fontFamily:"var(--mono)",fontWeight:700,textTransform:"uppercase",flexShrink:0}}>{fix.priority.replace("_"," ")}</span>
            </div>
            <p style={{fontSize:12,color:"var(--text-2)",margin:"0 0 9px",lineHeight:1.6}}>{fix.description}</p>
            {fix.commands&&fix.commands.length>0&&<div style={{position:"relative"}}>
              <div style={{position:"absolute",top:7,right:7}}><CopyBtn text={fix.commands.join("\n")}/></div>
              <pre style={{background:"var(--bg)",border:"1px solid var(--border)",borderRadius:6,padding:"9px 13px",fontSize:10,color:"var(--text-2)",fontFamily:"var(--mono)",margin:0,overflow:"auto"}}>{fix.commands.join("\n")}</pre>
            </div>}
          </div>;
        })}
      </div>)}
      {tab==="timeline"&&<div style={{background:"var(--bg-2)",border:"1px solid var(--border)",borderRadius:9,padding:14}}>
        {report.timeline_of_events.map((e,i)=><div key={i} style={{display:"flex",gap:11,marginBottom:10,alignItems:"flex-start"}}>
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",flexShrink:0,paddingTop:3}}>
            <div style={{width:7,height:7,borderRadius:"50%",background:"var(--accent)",flexShrink:0}}/>
            {i<report.timeline_of_events.length-1&&<div style={{width:1,height:18,background:"var(--border)",marginTop:2}}/>}
          </div>
          <span style={{fontSize:11,color:"var(--text-2)",fontFamily:"var(--mono)",lineHeight:1.5}}>{e}</span>
        </div>)}
      </div>}
    </div>
  );
}

// ─── History ──────────────────────────────────────────────────────────────────
function History({chats,onSelect}:{chats:Chat[];onSelect:(c:Chat)=>void}) {
  if(!chats.length) return <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"45vh",gap:8}}><span style={{fontSize:32,opacity:.15}}>◷</span><div style={{fontSize:13,color:"var(--text-3)"}}>No investigations yet</div></div>;
  return <div style={{maxWidth:720,margin:"0 auto"}}>
    <div style={{marginBottom:20}}><h2 style={{fontSize:18,fontWeight:700,color:"var(--text)",marginBottom:3}}>History</h2><p style={{fontSize:12,color:"var(--text-3)"}}>{chats.length} session{chats.length!==1?"s":""}</p></div>
    {[...chats].reverse().map(chat=>{
      const sev=chat.investigations[chat.investigations.length-1]?.report?.severity;
      const sc=sev?SEV[sev]:"var(--border-2)";
      return <div key={chat.id} onClick={()=>onSelect(chat)} style={{background:"var(--bg-2)",border:"1px solid var(--border)",borderRadius:9,padding:14,marginBottom:7,cursor:"pointer",borderLeft:`3px solid ${sc}`}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:6,gap:10,flexWrap:"wrap"}}>
          <div style={{fontSize:13,fontWeight:600,color:"var(--text)",flex:1}}>{chat.title}</div>
          <div style={{fontSize:9,color:"var(--text-4)",fontFamily:"var(--mono)"}}>{new Date(chat.created_at).toLocaleString()}</div>
        </div>
        <div style={{fontSize:11,color:"var(--text-3)",marginBottom:8}}>{chat.lastMessage}</div>
        <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
          <span style={{fontSize:9,padding:"2px 6px",borderRadius:3,background:"rgba(99,102,241,.08)",color:"var(--accent-2)",fontFamily:"var(--mono)"}}>{chat.investigations.length} inv.</span>
          {sev&&<span style={{fontSize:9,padding:"2px 6px",borderRadius:3,background:`${sc}12`,color:sc,fontFamily:"var(--mono)",fontWeight:700,textTransform:"uppercase"}}>{sev}</span>}
        </div>
      </div>;
    })}
  </div>;
}

// ─── Patterns ─────────────────────────────────────────────────────────────────
function Patterns({chats}:{chats:Chat[]}) {
  const all=chats.flatMap(c=>c.investigations); const done=all.filter(i=>i.report);
  if(!chats.length) return <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"45vh",gap:8}}><span style={{fontSize:32,opacity:.15}}>◈</span><div style={{fontSize:13,color:"var(--text-3)"}}>No patterns yet</div></div>;
  const tc:Record<string,number>={};
  all.forEach(i=>i.timeline.forEach(e=>{if(e.tool_call)tc[e.tool_call.tool_name]=(tc[e.tool_call.tool_name]||0)+1;}));
  const top=Object.entries(tc).sort((a,b)=>b[1]-a[1]).slice(0,7);
  const sc2:Record<string,number>={critical:0,high:0,medium:0,low:0};
  done.forEach(i=>{if(i.report?.severity)sc2[i.report.severity]++;});
  const avg=done.length?Math.round(done.reduce((s,i)=>s+(i.report?.confidence||0),0)/done.length):0;
  return <div style={{maxWidth:720,margin:"0 auto"}}>
    <div style={{marginBottom:20}}><h2 style={{fontSize:18,fontWeight:700,color:"var(--text)",marginBottom:3}}>Patterns</h2><p style={{fontSize:12,color:"var(--text-3)"}}>From {all.length} investigations</p></div>
    <div className="stats-grid" style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:9,marginBottom:16}}>
      {[{l:"Investigations",v:all.length,c:"var(--accent-2)"},{l:"Resolved",v:done.length,c:"var(--green)"},{l:"Avg Confidence",v:done.length?`${avg}%`:"—",c:"var(--purple)"}].map(s=>(
        <div key={s.l} style={{background:"var(--bg-2)",border:"1px solid var(--border)",borderRadius:9,padding:13,textAlign:"center"}}>
          <div style={{fontSize:24,fontWeight:800,color:s.c,fontFamily:"var(--mono)"}}>{s.v}</div>
          <div style={{fontSize:10,color:"var(--text-4)",marginTop:2}}>{s.l}</div>
        </div>
      ))}
    </div>
    {done.length>0&&<div style={{background:"var(--bg-2)",border:"1px solid var(--border)",borderRadius:9,padding:14,marginBottom:10}}>
      <div style={{fontSize:9,color:"var(--text-4)",fontFamily:"var(--mono)",letterSpacing:".07em",textTransform:"uppercase",marginBottom:10}}>Severity Distribution</div>
      {Object.entries(sc2).filter(([,n])=>n>0).map(([s,n])=>{const c=SEV[s];return(
        <div key={s} style={{display:"flex",alignItems:"center",gap:9,marginBottom:7}}>
          <span style={{fontSize:9,color:c,fontFamily:"var(--mono)",width:48,textTransform:"uppercase",fontWeight:600}}>{s}</span>
          <div style={{flex:1,height:5,background:"var(--bg-3)",borderRadius:3,overflow:"hidden"}}><div style={{width:`${(n/done.length)*100}%`,height:"100%",background:c,borderRadius:3,transition:"width .6s"}}/></div>
          <span style={{fontSize:10,color:"var(--text-3)",fontFamily:"var(--mono)",width:14,textAlign:"right"}}>{n}</span>
        </div>
      );})}
    </div>}
    {top.length>0&&<div style={{background:"var(--bg-2)",border:"1px solid var(--border)",borderRadius:9,padding:14}}>
      <div style={{fontSize:9,color:"var(--text-4)",fontFamily:"var(--mono)",letterSpacing:".07em",textTransform:"uppercase",marginBottom:10}}>Most Used Tools</div>
      {top.map(([t,n])=>(
        <div key={t} style={{display:"flex",alignItems:"center",gap:9,marginBottom:7}}>
          <span style={{fontSize:10,color:"var(--accent-2)",fontFamily:"var(--mono)",flex:1}}>{t}</span>
          <div style={{width:90,height:4,background:"var(--bg-3)",borderRadius:2,overflow:"hidden"}}><div style={{width:`${(n/(top[0]?.[1]||1))*100}%`,height:"100%",background:"var(--accent)",borderRadius:2}}/></div>
          <span style={{fontSize:10,color:"var(--text-4)",fontFamily:"var(--mono)",width:16,textAlign:"right"}}>{n}x</span>
        </div>
      ))}
    </div>}
  </div>;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const EXAMPLES=["Why are we getting 500 errors?","Is any EC2 instance running?","Check all database health","Why did last deploy fail?","CPU at 98% — investigate","MongoDB connections exhausted"];

export default function App() {
  const [chats,setChats]=useState<Chat[]>([]);
  const [cid,setCid]=useState<string|null>(null);
  const [iid,setIid]=useState<string|null>(null);
  const [nav,setNav]=useState<NavView>("chat");
  const [panel,setPanel]=useState<MainPanel>("timeline");
  const [input,setInput]=useState("");
  const [loading,setLoading]=useState(false);
  const [sbOpen,setSbOpen]=useState(false);
  const taRef=useRef<HTMLTextAreaElement>(null);

  const AGENT=typeof window!=="undefined"?(process.env.NEXT_PUBLIC_AGENT_URL||"http://localhost:3002"):"http://localhost:3002";
  const activeChat=chats.find(c=>c.id===cid)??null;
  const activeInv=activeChat?.investigations.find(i=>i.id===iid)??null;
  const sync=useCallback(()=>setChats([...chatStore]),[]);

  useEffect(()=>{
    if(!activeInv||activeInv.status==="completed"||activeInv.status==="failed") return;
    const iv=setInterval(async()=>{
      try{const r=await fetch(`${AGENT}/investigations/${activeInv.id}`);if(!r.ok)return;const u:Investigation=await r.json();const chat=chatStore.find(c=>c.id===cid);if(chat){const idx=chat.investigations.findIndex(i=>i.id===u.id);if(idx>=0)chat.investigations[idx]=u;}sync();if(u.report&&panel==="timeline")setPanel("report");}catch{}
    },2000);
    return()=>clearInterval(iv);
  },[activeInv,cid,AGENT,panel,sync]);

  const newChat=()=>{setCid(null);setIid(null);setNav("chat");setInput("");setPanel("timeline");setTimeout(()=>taRef.current?.focus(),80);};
  const selChat=(chat:Chat)=>{setCid(chat.id);const l=chat.investigations[chat.investigations.length-1];if(l){setIid(l.id);setPanel(l.report?"report":"timeline");}setNav("chat");};

  const submit=async(q2?:string)=>{
    const q=(q2??input).trim();if(!q||loading)return;
    setLoading(true);setPanel("timeline");
    let chatId=cid;
    if(!chatId){const nc:Chat={id:"chat-"+Math.random().toString(36).slice(2,8),title:q.length>55?q.slice(0,55)+"…":q,created_at:new Date().toISOString(),investigations:[],lastMessage:q};chatStore.push(nc);chatId=nc.id;setCid(chatId);}
    let inv:Investigation;
    try{const r=await fetch(`${AGENT}/investigations`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({incident_description:q,context:{service:"api",environment:"production",time_range_minutes:60}})});inv=r.ok?await r.json():createMock(q);}catch{inv=createMock(q);}
    const chat=chatStore.find(c=>c.id===chatId);if(chat){chat.investigations.push(inv);chat.lastMessage=q;}
    setIid(inv.id);sync();setLoading(false);setInput("");
  };

  const approve=async(ok:boolean)=>{
    if(!activeInv?.pending_tool_call||!cid)return;
    const tc=activeInv.pending_tool_call;
    try{const r=await fetch(`${AGENT}/investigations/${activeInv.id}/tool-approval`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({tool_call_id:tc.id,approved:ok})});if(r.ok){const u:Investigation=await r.json();const chat=chatStore.find(c=>c.id===cid);if(chat){const idx=chat.investigations.findIndex(i=>i.id===u.id);if(idx>=0)chat.investigations[idx]=u;}sync();return;}}catch{}
    const chat=chatStore.find(c=>c.id===cid);if(!chat)return;
    const idx=chat.investigations.findIndex(i=>i.id===activeInv.id);if(idx<0)return;
    const inv=chat.investigations[idx];
    const ne:TimelineEvent={id:"t-"+Date.now(),timestamp:new Date().toISOString(),type:"observation",title:(ok?"Executed: ":"Rejected: ")+tc.tool_name,description:ok?"Tool executed successfully.":"Tool rejected."};
    chat.investigations[idx]={...inv,pending_tool_call:undefined,status:"running",timeline:[...inv.timeline,ne]};sync();
    if(ok&&inv.report)setTimeout(()=>{const c=chatStore.find(c=>c.id===cid);if(!c)return;const i=c.investigations.findIndex(i=>i.id===activeInv.id);if(i>=0){c.investigations[i]={...c.investigations[i],status:"completed"};sync();setPanel("report");}},1200);
  };

  const stCol:Record<string,string>={running:"var(--yellow)",waiting_approval:"var(--accent-2)",completed:"var(--green)",failed:"var(--red)"};
  const stLbl:Record<string,string>={running:"Investigating",waiting_approval:"Awaiting Approval",completed:"Complete",failed:"Failed"};

  return (
    <div style={{display:"flex",height:"100vh",overflow:"hidden",background:"var(--bg)",fontFamily:"var(--font)"}}>
      <style>{`
        *{box-sizing:border-box;} button{font-family:var(--font);} textarea::placeholder{color:var(--text-4);}
        @keyframes fadeUp{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:translateY(0)}}
        @keyframes slideIn{from{opacity:0;transform:translateX(-5px)}to{opacity:1;transform:translateX(0)}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
        .sidebar{position:relative;transition:transform .24s ease;}
        @media(max-width:768px){
          .sidebar{position:fixed!important;left:0;top:0;height:100vh;z-index:50;transform:translateX(-100%);}
          .sidebar.sidebar-open{transform:translateX(0)!important;}
          .close-sb{display:flex!important;}
          .mob-overlay{display:block!important;}
          .main-pad{padding:14px!important;}
          .stats-grid{grid-template-columns:repeat(2,1fr)!important;}
        }
        @media(max-width:440px){.stats-grid{grid-template-columns:1fr!important;}.tab-row{overflow-x:auto;}}
        .mob-overlay{display:none;}
      `}</style>

      <Sidebar chats={chats} activeChatId={cid} navView={nav} onNew={newChat} onNav={setNav} onSelectChat={selChat} open={sbOpen} setOpen={setSbOpen}/>

      <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",minWidth:0}}>
        {/* Header */}
        <header style={{padding:"11px 18px",borderBottom:"1px solid var(--border)",display:"flex",alignItems:"center",gap:10,background:"var(--bg-1)",flexShrink:0}}>
          <button onClick={()=>setSbOpen(!sbOpen)} style={{width:30,height:30,borderRadius:6,border:"1px solid var(--border)",background:"transparent",color:"var(--text-3)",fontSize:15,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>≡</button>
          <div style={{flex:1,minWidth:0,fontSize:14,fontWeight:700,color:"var(--text)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
            {nav==="history"?"History":nav==="patterns"?"Patterns":activeInv?activeInv.incident_description:"Investigate"}
          </div>
          <div style={{display:"flex",alignItems:"center",gap:7,flexShrink:0}}>
            {activeInv&&nav==="chat"&&<div style={{display:"flex",alignItems:"center",gap:5}}>
              <span style={{width:6,height:6,borderRadius:"50%",background:stCol[activeInv.status],animation:activeInv.status==="running"?"pulse 1.5s infinite":"none",flexShrink:0}}/>
              <span style={{fontSize:10,color:stCol[activeInv.status],fontFamily:"var(--mono)",fontWeight:600}}>{stLbl[activeInv.status]}</span>
            </div>}
            <span style={{fontSize:9,padding:"3px 7px",borderRadius:3,background:"rgba(239,68,68,.07)",border:"1px solid rgba(239,68,68,.16)",color:"var(--red)",fontFamily:"var(--mono)",fontWeight:600}}>READ-ONLY</span>
          </div>
        </header>

        {/* Main */}
        <main className="main-pad" style={{flex:1,overflow:"auto",padding:"22px 22px"}}>
          {nav==="history"&&<History chats={chats} onSelect={selChat}/>}
          {nav==="patterns"&&<Patterns chats={chats}/>}
          {nav==="chat"&&<>
            {!activeInv&&(
              <div style={{maxWidth:600,margin:"0 auto",padding:"40px 0 28px",animation:"fadeUp .35s ease-out"}}>
                <div style={{textAlign:"center",marginBottom:28}}>
                  <div style={{width:50,height:50,borderRadius:14,background:"linear-gradient(135deg,#312e81,#4f46e5)",display:"inline-flex",alignItems:"center",justifyContent:"center",fontSize:22,marginBottom:16,boxShadow:"0 0 36px rgba(99,102,241,.18)"}}>⬡</div>
                  <h1 style={{fontSize:24,fontWeight:800,color:"var(--text)",marginBottom:7,letterSpacing:"-.03em"}}>AI DevOps Investigator</h1>
                  <p style={{fontSize:13,color:"var(--text-3)",lineHeight:1.7,margin:0}}>Describe an incident or ask a question.<br/>The AI investigates your real infrastructure and provides step-by-step fix plans.</p>
                </div>
                <div style={{background:"var(--bg-2)",border:"1px solid var(--border)",borderRadius:11,overflow:"hidden",marginBottom:18}}>
                  <textarea ref={taRef} value={input} onChange={e=>setInput(e.target.value)}
                    onKeyDown={e=>{if(e.key==="Enter"&&(e.metaKey||e.ctrlKey))submit();}}
                    placeholder="Why are we getting 500 errors from the API?"
                    style={{width:"100%",minHeight:90,padding:"14px 16px",background:"transparent",border:"none",outline:"none",color:"var(--text)",fontSize:13,fontFamily:"var(--font)",resize:"none",lineHeight:1.6}}
                  />
                  <div style={{padding:"9px 12px 11px",display:"flex",justifyContent:"space-between",alignItems:"center",borderTop:"1px solid var(--border)"}}>
                    <span style={{fontSize:10,color:"var(--text-4)",fontFamily:"var(--mono)"}}>⌘↵ to run</span>
                    <button onClick={()=>submit()} disabled={!input.trim()||loading} style={{padding:"7px 18px",borderRadius:6,border:"none",cursor:input.trim()?"pointer":"not-allowed",background:input.trim()?"var(--accent)":"var(--bg-3)",color:input.trim()?"#fff":"var(--text-4)",fontWeight:600,fontSize:12,boxShadow:input.trim()?"0 0 20px rgba(99,102,241,.22)":"none",transition:"all .2s",fontFamily:"var(--font)"}}>
                      {loading?"Starting…":"Investigate →"}
                    </button>
                  </div>
                </div>
                <div style={{display:"flex",flexWrap:"wrap",gap:6,justifyContent:"center"}}>
                  {EXAMPLES.map((q,i)=>(
                    <button key={i} onClick={()=>submit(q)} style={{padding:"6px 12px",borderRadius:18,border:"1px solid var(--border)",background:"transparent",color:"var(--text-3)",fontSize:11,cursor:"pointer",transition:"all .14s",fontFamily:"var(--font)"}}>{q}</button>
                  ))}
                </div>
              </div>
            )}

            {activeInv&&(
              <div style={{maxWidth:760,margin:"0 auto"}}>
                {activeInv.pending_tool_call&&activeInv.status==="waiting_approval"&&<ToolApproval tc={activeInv.pending_tool_call} onA={()=>approve(true)} onR={()=>approve(false)}/>}

                <div className="tab-row" style={{display:"flex",gap:2,marginBottom:18,background:"var(--bg-2)",border:"1px solid var(--border)",borderRadius:8,padding:3}}>
                  {([{id:"timeline" as const,l:`Timeline (${activeInv.timeline.length})`},{id:"evidence" as const,l:`Evidence (${activeInv.evidence.length})`},{id:"report" as const,l:"Fix Plan"}]).map(t=>(
                    <button key={t.id} onClick={()=>setPanel(t.id)} style={{flex:1,padding:"6px 9px",borderRadius:5,border:"none",cursor:"pointer",background:panel===t.id?"var(--bg-3)":"transparent",color:panel===t.id?"var(--text)":"var(--text-3)",fontWeight:panel===t.id?600:400,fontSize:11,whiteSpace:"nowrap",fontFamily:"var(--font)"}}>
                      {t.l}
                    </button>
                  ))}
                  <button onClick={()=>{setIid(null);setNav("chat");}} style={{padding:"6px 10px",borderRadius:5,border:"none",cursor:"pointer",background:"transparent",color:"var(--text-4)",fontSize:10,whiteSpace:"nowrap",fontFamily:"var(--font)"}}>+ New</button>
                </div>

                {activeChat&&activeChat.investigations.length>1&&(
                  <div style={{marginBottom:12,display:"flex",gap:5,flexWrap:"wrap"}}>
                    {activeChat.investigations.map((inv,i)=>(
                      <button key={inv.id} onClick={()=>{setIid(inv.id);setPanel(inv.report?"report":"timeline");}} style={{padding:"3px 9px",borderRadius:5,border:iid===inv.id?"1px solid var(--accent)":"1px solid var(--border)",background:iid===inv.id?"rgba(99,102,241,.08)":"transparent",color:iid===inv.id?"var(--accent-2)":"var(--text-3)",fontSize:10,fontFamily:"var(--font)"}}>
                        #{i+1} {inv.incident_description.slice(0,26)}{inv.incident_description.length>26?"…":""}
                      </button>
                    ))}
                  </div>
                )}

                {panel==="timeline"&&<div>
                  {activeInv.timeline.map((e,i)=><TLItem key={e.id} event={e} index={i}/>)}
                  {activeInv.status==="running"&&<div style={{display:"flex",gap:9,alignItems:"center",color:"var(--text-4)",marginTop:3}}>
                    <div style={{width:26,height:26,borderRadius:"50%",background:"var(--bg-2)",display:"flex",alignItems:"center",justifyContent:"center",animation:"pulse 1.5s infinite",fontSize:11}}>⬡</div>
                    <span style={{fontSize:11,fontFamily:"var(--mono)"}}>AI investigating…</span>
                  </div>}
                </div>}
                {panel==="evidence"&&<div>
                  {activeInv.evidence.length===0?<div style={{textAlign:"center",padding:"44px 0",color:"var(--text-4)"}}><div style={{fontSize:26,marginBottom:9,opacity:.25}}>◈</div><p style={{fontSize:12}}>Evidence appears as tools execute</p></div>
                  :activeInv.evidence.map(e=><EvCard key={e.id} ev={e}/>)}
                </div>}
                {panel==="report"&&<div>
                  {activeInv.report?<Report report={activeInv.report}/>
                  :<div style={{textAlign:"center",padding:"44px 0",color:"var(--text-4)"}}><div style={{fontSize:26,marginBottom:9,opacity:.25}}>⬡</div><p style={{fontSize:12}}>Fix plan generated when investigation completes</p><p style={{fontSize:10,marginTop:3}}>Approve tool calls to continue</p></div>}
                </div>}
              </div>
            )}
          </>}
        </main>

        {/* Bottom input */}
        {nav==="chat"&&activeInv&&(
          <div style={{borderTop:"1px solid var(--border)",padding:"10px 18px",background:"var(--bg-1)",flexShrink:0}}>
            <div style={{maxWidth:760,margin:"0 auto",display:"flex",gap:7}}>
              <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")submit();}}
                placeholder="Ask another question…"
                style={{flex:1,padding:"8px 13px",borderRadius:7,border:"1px solid var(--border)",background:"var(--bg-2)",color:"var(--text)",fontSize:12,fontFamily:"var(--font)",outline:"none",minWidth:0}}
              />
              <button onClick={()=>submit()} disabled={!input.trim()||loading} style={{padding:"8px 16px",borderRadius:7,border:"none",background:input.trim()?"var(--accent)":"var(--bg-3)",color:input.trim()?"#fff":"var(--text-4)",fontWeight:600,fontSize:13,flexShrink:0,fontFamily:"var(--font)"}}>
                {loading?"…":"→"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
