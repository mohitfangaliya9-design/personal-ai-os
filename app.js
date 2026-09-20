const $=s=>document.querySelector(s);
async function api(url,opts){const r=await fetch(url,{headers:{'Content-Type':'application/json',...(opts?.headers||{})},...opts});const j=await r.json();if(!r.ok)throw new Error(j.error||'Request failed');return j}
async function refresh(){
  try{const h=await api('/health');$('#health').textContent=`System ${h.status}`;$('#health').title=`DB: ${h.database} · AI: ${h.ai} · MCP: ${h.mcp}`;}catch(e){$('#health').textContent='Offline'}
  try{const a=await api('/api/agents');$('#agents').innerHTML=a.length?a.map(x=>`<div class="item"><b>${x.name}</b><br><small>${x.role}</small></div>`).join(''):'<div class="muted">No agents yet.</div>';}catch(e){$('#agents').textContent=e.message}
  try{const t=await api('/api/tasks');$('#tasks').innerHTML=t.length?t.slice(0,8).map(x=>`<div class="item"><b>${x.status}</b><br><small>${escapeHtml(x.request)}</small></div>`).join(''):'<div class="muted">No tasks yet.</div>';}catch(e){$('#tasks').textContent=e.message}
}
function escapeHtml(s){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
$('#run').onclick=async()=>{const request=$('#request').value.trim();if(!request)return;const out=$('#output');out.style.display='block';out.textContent='Planning…';try{const r=await api('/api/tasks',{method:'POST',body:JSON.stringify({request})});out.textContent=JSON.stringify(r,null,2);$('#request').value='';await refresh()}catch(e){out.textContent=`Error: ${e.message}`}};
$('#refresh').onclick=refresh;refresh();
