/**
 * Deterministic "constellation" artwork for application cards, idea cards and the composer hero.
 * Ported (idea + algorithm) from deploykit's webui/lib/sigil.ts and components/AppArt.tsx --
 * MIT, (c) Wes Sonnenreich: FNV-1a hash, mulberry32 PRNG, Poisson-disc-ish star scatter, a
 * minimum-spanning-tree stick figure (+ one loop for repeated letter pairs), and a hue on a
 * flattering 250-degree arc. Dependency-free; every function is a pure function of its seed, and
 * output contains only numbers derived from the seed (no caller strings reach the markup).
 * Colours come from CSS (--pac-* brand variables + a per-element --h hue), never hard-coded here:
 * the SVG is inline markup styled by classes in style.css, so it works under CSP style-src 'self'.
 */
export function hash(s){let h=0x811c9dc5;s=String(s);for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,0x01000193);}return h>>>0;}
function rng(seed){let a=seed;return()=>{a=(a+0x6d2b79f5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
/** Hue in [0,360): golden-ratio scramble of the hash mapped onto the 165..415 arc (skips acid yellow-greens). */
export function hueFor(key){const t=(hash(key)*0.6180339887498949)%1;return Math.round(165+t*250)%360;}
/** The constellation model: normalised star coords in the unit disc, MST edges, background dust. */
export function sigilModel(seed,key=seed){
  const text=(String(seed).toLowerCase().replace(/[^a-z0-9]+/g,'')||String(key).toLowerCase().replace(/[^a-z0-9]+/g,''))||'app';
  const freq=new Map();for(const ch of text)freq.set(ch,(freq.get(ch)??0)+1);
  let letters=[...freq.keys()];while(letters.length<4)letters=[...letters,...letters].slice(0,4);letters=letters.slice(0,9);
  const maxF=Math.max(...freq.values()),rand=rng(hash(key)),n=letters.length;
  let minDist=1.55/Math.sqrt(n),tries=0;const pts=[];
  while(pts.length<n){const a=rand()*Math.PI*2,r=Math.sqrt(rand())*0.95,p={x:r*Math.cos(a),y:r*Math.sin(a)};if(pts.every(q=>Math.hypot(p.x-q.x,p.y-q.y)>=minDist))pts.push(p);if(++tries>400){minDist*=0.9;tries=0;}}
  const d=(i,j)=>Math.hypot(pts[i].x-pts[j].x,pts[i].y-pts[j].y),inTree=new Set([0]),edges=[];
  while(inTree.size<n){let best=null,bd=Infinity;for(const i of inTree)for(let j=0;j<n;j++)if(!inTree.has(j)&&d(i,j)<bd){bd=d(i,j);best=[i,j];}edges.push(best);inTree.add(best[1]);}
  const pairs=new Map();for(let i=0;i+1<text.length;i++){const k=text.slice(i,i+2);pairs.set(k,(pairs.get(k)??0)+1);}
  if(n>=5&&[...pairs.values()].some(c=>c>1)){
    const has=(i,j)=>edges.some(([a,b])=>(a===i&&b===j)||(a===j&&b===i));
    const o=(p,q,r)=>Math.sign((pts[q].x-pts[p].x)*(pts[r].y-pts[p].y)-(pts[q].y-pts[p].y)*(pts[r].x-pts[p].x));
    const crosses=(i,j)=>edges.some(([a,b])=>a!==i&&a!==j&&b!==i&&b!==j&&o(i,j,a)!==o(i,j,b)&&o(a,b,i)!==o(a,b,j));
    const avg=edges.reduce((s,[a,b])=>s+d(a,b),0)/edges.length;let best=null,bd=1.6*avg;
    for(let i=0;i<n;i++)for(let j=i+1;j<n;j++)if(!has(i,j)&&d(i,j)<bd&&!crosses(i,j)){best=[i,j];bd=d(i,j);}
    if(best)edges.push(best);
  }
  const stars=letters.map((ch,i)=>({...pts[i],weight:(freq.get(ch)??1)/maxF}));
  const dust=Array.from({length:34},()=>({x:rand()*2-1,y:rand()*2-1,r:0.3+rand()*0.9,o:0.15+rand()*0.5}));
  return {hue:hueFor(key),stars,edges,dust};
}
const f=v=>Math.round(v*10)/10;
/** Inline SVG string. opts: {w,h,key} -- `seed` decides the figure (its letters); `key` (default seed) the scatter + hue. */
export function sigilSvg(seed,{w=200,h=120,key}={}){
  const m=sigilModel(seed,key??seed),cx=w/2,cy=h/2,sx=w*0.44,sy=h*0.4,px=s=>f(cx+s.x*sx),py=s=>f(cy+s.y*sy),u=Math.min(w,h)/120;
  const dust=m.dust.map(p=>`<circle class="dust" cx="${f(cx+p.x*w/2)}" cy="${f(cy+p.y*h/2)}" r="${f(p.r*u)}" opacity="${f(p.o)}"/>`).join('');
  const lines=m.edges.map(([a,b])=>`<line class="ln" x1="${px(m.stars[a])}" y1="${py(m.stars[a])}" x2="${px(m.stars[b])}" y2="${py(m.stars[b])}"/>`).join('');
  const stars=m.stars.map(s=>{const r=f((1.6+s.weight*2.4)*u);return `<g class="star"><circle class="halo" cx="${px(s)}" cy="${py(s)}" r="${f(r*3.4)}"/><circle class="st" cx="${px(s)}" cy="${py(s)}" r="${r}"/></g>`;}).join('');
  return `<svg class="sigil" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">${dust}${lines}${stars}</svg>`;
}
/** Per-element aurora custom properties (applied through the CSSOM -- never a style="" attribute). */
export function auroraStyle(seed,hue){const h=hue??hueFor(seed);return {'--h':String(h),'--h2':String((h+26)%360),'--h3':String((h+336)%360)};}
export function applyAurora(el,seed,hue){for(const [k,v] of Object.entries(auroraStyle(seed,hue)))el.style.setProperty(k,v);}
/** Paint every [data-seed] under root (call after injecting markup). */
export function paintArt(root=document){root.querySelectorAll('[data-seed]').forEach(el=>applyAurora(el,el.dataset.seed));}
