(() => {
"use strict";
const API=(window.VF_API_BASE||"").replace(/\/$/,"");
const $=id=>document.getElementById(id);
const tokenKey="vf_online_guest_token";
let token=localStorage.getItem(tokenKey)||"",currentMatch=null,ws=null,lastState=null,pollTimer=null,animation=0;
const apiReady=API&&!API.includes("YOUR-WORKER");
function authHeaders(){return token?{"authorization":"Bearer "+token}:{}}
async function call(path,options={}) {
  const response=await fetch(API+path,{...options,headers:{"content-type":"application/json",...authHeaders(),...(options.headers||{})}});
  const data=await response.json().catch(()=>({error:"استجابة غير مفهومة"}));
  if(!response.ok)throw new Error(data.error||"حدث خطأ");
  return data;
}
function showLogin(message){
  $("login").classList.remove("hidden");$("lobby").classList.add("hidden");
  $("loginMsg").textContent=message||"";
}
function showLobby(user){
  $("login").classList.add("hidden");$("lobby").classList.remove("hidden");
  $("welcome").textContent="أهلاً، "+user.nickname;$("balance").textContent=Number(user.balance).toLocaleString("en-US");
}
async function refreshMe(){
  const data=await call("/api/me");showLobby(data.user);await loadMatches();
}
$("loginForm").addEventListener("submit",async e=>{
  e.preventDefault();if(!apiReady)return;
  $("loginMsg").textContent="جارٍ إنشاء جلسة الزائر...";
  try{const data=await call("/api/guest",{method:"POST",body:JSON.stringify({nickname:$("nickname").value})});token=data.token;localStorage.setItem(tokenKey,token);showLobby(data.user);await loadMatches();}
  catch(error){$("loginMsg").textContent=error.message;}
});
$("logout").onclick=()=>{token="";localStorage.removeItem(tokenKey);showLogin("تم تسجيل الخروج من هذا الجهاز.");};
$("refresh").onclick=loadMatches;
function make(tag,cls,text){const el=document.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el;}
function teamNode(name,logo){const el=make("div","team");const img=document.createElement("img");img.src=logo;img.alt="";el.append(img,make("span","",name));return el;}
function formatTime(ms){return new Date(ms).toLocaleString("ar-EG",{weekday:"short",hour:"2-digit",minute:"2-digit"});}
async function loadMatches(){
  if(!apiReady){$("listMsg").textContent="قبل التشغيل: اربط هذه الصفحة بعنوان Worker بعد نشره في Cloudflare، ثم عدّل online-config.js.";return;}
  $("listMsg").textContent="جارٍ تحميل المباريات...";
  try{
    const data=await call("/api/matches");const host=$("matches");host.replaceChildren();
    if(!data.matches.length){host.append(make("p","muted","سيظهر جدول المباريات بعد تشغيل مجدول السيرفر لأول مرة."));}
    data.matches.forEach(m=>host.append(renderMatch(m)));
    $("listMsg").textContent=data.matches.length?"تم تحميل جدول المباريات.":"";
    const me=await call("/api/me");$("balance").textContent=Number(me.user.balance).toLocaleString("en-US");
  }catch(error){$("listMsg").textContent=error.message;if(error.message.includes("جلسة")||error.message.includes("سجّل"))showLogin(error.message);}
}
function renderMatch(m){
  const card=make("article","match");
  const top=make("div","row");const status=make("span","status "+(m.status==="live"?"live":m.status==="scheduled"?"open":""));status.textContent=m.status==="live"?"مباشرة":m.status==="finished"?"انتهت":"الرهان قبل البداية";top.append(status,make("span","muted",formatTime(m.starts_at)));card.append(top);
  const teams=make("div","teams");teams.append(teamNode(m.home_name,m.home_logo),make("div","score",m.status==="scheduled"?"VS":m.home_score+" - "+m.away_score),teamNode(m.away_name,m.away_logo));card.append(teams);
  if(m.status==="scheduled"){
    const odds=make("div","odds");
    [["فوز "+m.home_name,m.odds_home],["تعادل",m.odds_draw],["فوز "+m.away_name,m.odds_away]].forEach(x=>{const l=make("label","",x[0]);l.append(make("b","",Number(x[1]).toFixed(2)));odds.append(l);});card.append(odds);
    const row=make("div","betrow"),pick=make("select"),stake=make("input"),button=make("button","btn primary","تأكيد الرهان");
    [["home","فوز "+m.home_name],["draw","تعادل"],["away","فوز "+m.away_name]].forEach(x=>{const o=make("option","",x[1]);o.value=x[0];pick.append(o);});
    stake.type="number";stake.min="1";stake.max="500";stake.value="50";stake.placeholder="النقاط";
    row.append(pick,stake,button);card.append(row);
    const msg=make("p","message");
    button.onclick=async()=>{button.disabled=true;msg.textContent="جارٍ تسجيل الرهان...";
      try{const result=await call("/api/matches/"+encodeURIComponent(m.id)+"/bets",{method:"POST",body:JSON.stringify({pick:pick.value,stake:Number(stake.value)})});$("balance").textContent=Number(result.balance).toLocaleString("en-US");msg.textContent="تم الرهان بنجاح · معامل "+Number(result.odds).toFixed(2);}
      catch(error){msg.textContent=error.message;}finally{button.disabled=false;}
    };card.append(msg);
  }else if(m.status==="live"){
    const button=make("button","btn primary","مشاهدة المباراة الآن");button.style.width="100%";button.onclick=()=>openViewer(m);card.append(button);
  }else card.append(make("p","muted","انتهت المباراة وتمت تسوية الرهانات."));
  return card;
}
function openViewer(match){
  currentMatch=match;$("viewerModal").classList.remove("hidden");$("viewerTitle").textContent=match.home_name+" × "+match.away_name;
  $("homeName").textContent=match.home_name;$("awayName").textContent=match.away_name;
  if(ws){try{ws.close();}catch(_){}}
  if(pollTimer)clearInterval(pollTimer);
  const socketUrl=API.replace(/^http/,"ws")+"/api/matches/"+encodeURIComponent(match.id)+"/live";
  try{ws=new WebSocket(socketUrl);ws.onmessage=e=>{try{applyState(JSON.parse(e.data));}catch(_){}};ws.onclose=()=>startPolling();ws.onerror=()=>startPolling();}
  catch(_){startPolling();}
  call("/api/matches/"+encodeURIComponent(match.id)).then(applyState).catch(()=>{});
  if(!animation)drawLoop();
}
function startPolling(){if(pollTimer||!currentMatch)return;pollTimer=setInterval(()=>call("/api/matches/"+encodeURIComponent(currentMatch.id)).then(applyState).catch(()=>{}),1000);}
function applyState(state){
  lastState=state;$("viewerScore").textContent=state.score[0]+" - "+state.score[1];
  $("viewerPhase").textContent=state.phase;$("viewerClock").textContent=state.status==="scheduled"?"تبدأ المباراة "+formatTime(state.startsAt):"الدقيقة "+state.minute+" / 90";
  const list=$("events");list.replaceChildren();(state.events||[]).slice(0,12).forEach(ev=>list.append(make("li","",ev.minute+"' · "+ev.text)));
  if(state.status==="finished"){if(ws){ws.close();ws=null;}if(pollTimer){clearInterval(pollTimer);pollTimer=null;}loadMatches();}
}
$("closeViewer").onclick=()=>{currentMatch=null;lastState=null;if(ws){ws.close();ws=null;}if(pollTimer){clearInterval(pollTimer);pollTimer=null;}$("viewerModal").classList.add("hidden");};
function drawPitch(){
  const c=$("pitch"),g=c.getContext("2d"),w=c.width,h=c.height;
  g.clearRect(0,0,w,h);g.fillStyle="#27843d";g.fillRect(0,0,w,h);
  for(let i=0;i<12;i++){g.fillStyle=i%2?"#23803a":"#2b9145";g.fillRect(i*w/12,0,w/12+1,h);}
  g.strokeStyle="#ffffffcc";g.lineWidth=3;g.strokeRect(18,18,w-36,h-36);g.beginPath();g.moveTo(w/2,18);g.lineTo(w/2,h-18);g.stroke();g.beginPath();g.arc(w/2,h/2,82,0,Math.PI*2);g.stroke();g.strokeRect(18,h*.25,145,h*.5);g.strokeRect(w-163,h*.25,145,h*.5);
  if(!lastState)return;
  (lastState.players||[]).forEach(p=>{const x=p.x*w,y=p.y*h,team=p.team===0?lastState.home:lastState.away;g.fillStyle="#0007";g.beginPath();g.arc(x+3,y+5,15,0,Math.PI*2);g.fill();g.save();g.beginPath();g.arc(x,y,14,0,Math.PI*2);g.clip();g.fillStyle=team.color||"#fff";g.fillRect(x-14,y-14,28,28);let img=getLogo(team.logo);if(img&&img.complete&&img.naturalWidth)g.drawImage(img,x-13,y-13,26,26);g.restore();g.strokeStyle=p.keeper?"#ffd05b":"#fff";g.lineWidth=p.keeper?4:2;g.beginPath();g.arc(x,y,14,0,Math.PI*2);g.stroke();});
  const bx=lastState.ball.x*w,by=lastState.ball.y*h;g.fillStyle="#fff";g.strokeStyle="#111";g.lineWidth=2;g.beginPath();g.arc(bx,by,8,0,Math.PI*2);g.fill();g.stroke();
}
const logoCache={};
function getLogo(src){if(!logoCache[src]){const img=new Image();img.src=src;logoCache[src]=img;}return logoCache[src];}
function drawLoop(){animation=requestAnimationFrame(drawLoop);drawPitch();}
if(apiReady&&token){refreshMe().catch(error=>{showLogin(error.message);});}else showLogin(apiReady?"سجّل باسم مستعار للبدء.":"اضبط عنوان السيرفر في online-config.js بعد نشر backend على Cloudflare.");
setInterval(()=>{if(!$("lobby").classList.contains("hidden"))loadMatches();},15000);
})();
