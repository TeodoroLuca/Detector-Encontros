import type { Encontro, TipoEncontro, PosicaoGeografica } from '../src/types.js';


export type MapMode = 'geografico' | 'tecnico';
export type TileStatus = 'idle' | 'loading' | 'ready' | 'unavailable';
export interface MapEncounter extends Encontro {
  _location: PosicaoGeografica;
  _key: number;
}
interface Point { x: number; y: number }
interface MapTile { state: 'loading' | 'loaded' | 'error'; image: HTMLImageElement }
interface Country { r: [number, number][][] }
interface HitTarget extends Point { radius: number; items: MapEncounter[] }
interface MarkerCell extends Point { items: MapEncounter[]; counts: Partial<Record<TipoEncontro, number>> }

declare global {
  interface Window { EncounterMap: typeof EncounterMap }
}

function isCountries(data: unknown): data is Country[] {
  return Array.isArray(data) && data.every((country: unknown) => {
    if (typeof country !== 'object' || country === null || !('r' in country) || !Array.isArray(country.r)) return false;
    return country.r.every((ring: unknown) => Array.isArray(ring) && ring.every((point: unknown) =>
      Array.isArray(point) && point.length === 2 && point.every((value: unknown) => typeof value === 'number' && Number.isFinite(value))));
  });
}

/* Mapa duplo: técnico offline + cartografia OpenStreetMap sob demanda. Projeção Web Mercator. */

  const TAU = Math.PI * 2;
  const TILE = 512;
  const clamp = (v: number, low: number, high: number) => Math.max(low, Math.min(high, v));
  const rad = (value: number) => value * Math.PI / 180;
  function xy(lon: number, lat: number): Point {
    const safe = clamp(lat, -85, 85);
    return { x: (lon + 180) / 360, y: (1 - Math.log(Math.tan(Math.PI / 4 + rad(safe) / 2)) / Math.PI) / 2 };
  }
  function latlon(x: number, y: number): PosicaoGeografica {
    return { lon: x * 360 - 180, lat: (2 * Math.atan(Math.exp(Math.PI * (1 - 2 * y))) - Math.PI / 2) * 180 / Math.PI };
  }
  function geoPair(item: Encontro): PosicaoGeografica | null {
    const [a, b] = item.monitoradosEncontro;
    const pa = item.posicoes[a], pb = item.posicoes[b];
    if (!pa || !pb) return null;
    let delta = pb.lon - pa.lon;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    const lon = ((pa.lon + delta / 2 + 540) % 360) - 180;
    return { lon, lat: (pa.lat + pb.lat) / 2 };
  }
  const COLORS = { generico: '#c9cbd2', faccao: '#c77578', protetiva: '#f0444b' };
  export class EncounterMap {
    readonly canvas: HTMLCanvasElement;
    readonly tooltip: HTMLElement;
    readonly ctx: CanvasRenderingContext2D;
    readonly parent: HTMLElement;
    data: MapEncounter[];
    filter: TipoEncontro | '';
    mode: MapMode;
    tileCache: Map<string, MapTile>;
    lastStatus: TileStatus | '';
    tileStatus: TileStatus;
    selectedItem: MapEncounter | null;
    onTileStatus: (status: TileStatus) => void;
    repaintQueued: boolean;
    countries: Country[];
    camera: Point & { zoom: number };
    hitTargets: HitTarget[];
    drag: (Point & { moved: boolean }) | null;
    pointers: Map<number, Point>;
    onSelect: (item: MapEncounter) => void;
    onZoom: (zoom: number) => void;
    resizeObserver: ResizeObserver;
    w = 0;
    h = 0;

    constructor(canvas: HTMLCanvasElement, tooltip: HTMLElement) {
      this.canvas = canvas;
      this.tooltip = tooltip;
      const context = canvas.getContext('2d', { alpha: false });
      const parent = canvas.parentElement;
      if (!context || !parent) throw new Error('Não foi possível inicializar o mapa.');
      this.ctx = context;
      this.parent = parent;
      this.data = [];
      this.filter = '';
      this.mode = 'geografico';
      this.tileCache = new Map();
      this.lastStatus = '';
      this.tileStatus = 'idle';
      this.selectedItem = null;
      this.onTileStatus = () => {};
      this.repaintQueued = false;
      this.countries = [];
      this.camera = { x: xy(-50, -14).x, y: xy(-50, -14).y, zoom: 1.5 };
      this.hitTargets = [];
      this.drag = null;
      this.pointers = new Map();
      this.onSelect = () => {};
      this.onZoom = () => {};
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.parent);
      this.setupInteractions();
      this.resize();
      fetch('/world.json').then(response => { if (!response.ok) throw Error(); return response.json(); })
        .then((data: unknown) => { if (isCountries(data)) this.countries = data; this.draw(); }).catch(() => this.draw());
    }
    get visibleData() { return this.filter ? this.data.filter(item => item.tipo === this.filter) : this.data; }
    setData(data: readonly Encontro[], fit = true) {
      this.data = data.map((item, index) => ({...item, _location: geoPair(item), _key: index})).filter((item): item is MapEncounter => item._location !== null);
      this.selectedItem = null;
      if (fit) this.fit(); else this.draw();
    }
    setMode(mode: MapMode) {
      if (mode !== 'tecnico' && mode !== 'geografico') return;
      if (this.mode === mode) return;
      this.mode = mode;
      this.hideTooltip();
      this.draw();
    }
    setFilter(type: TipoEncontro | '') { this.filter = type; this.fit(); }
    resize() {
      const rect = this.parent.getBoundingClientRect();
      const width = Math.max(240, Math.round(rect.width));
      const height = Math.max(220, Math.round(rect.height));
      this.w = width; this.h = height;
      const dpr = clamp(window.devicePixelRatio || 1, 1, 2);
      this.canvas.width = Math.round(width * dpr);
      this.canvas.height = Math.round(height * dpr);
      this.canvas.style.width = `${width}px`;
      this.canvas.style.height = `${height}px`;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.draw();
    }
    worldScale() { return TILE * (2 ** this.camera.zoom); }
    project(lon: number, lat: number) {
      const pos = xy(lon, lat), scale = this.worldScale();
      let dx = pos.x - this.camera.x;
      if (dx > 0.5) dx -= 1;
      if (dx < -0.5) dx += 1;
      return { x: this.w / 2 + dx * scale, y: this.h / 2 + (pos.y - this.camera.y) * scale };
    }
    panBy(dx: number, dy: number) {
      const scale = this.worldScale();
      this.camera.x = ((this.camera.x - dx / scale) % 1 + 1) % 1;
      this.camera.y = clamp(this.camera.y - dy / scale, .01, .99);
      this.draw();
    }
    zoomBy(delta: number, x = this.w / 2, y = this.h / 2) {
      const before = this.worldScale();
      const oldZoom = this.camera.zoom;
      this.camera.zoom = clamp(oldZoom + delta, .4, 18);
      const after = this.worldScale();
      const mapX = this.camera.x + (x - this.w / 2) / before;
      const mapY = this.camera.y + (y - this.h / 2) / before;
      this.camera.x = ((mapX - (x - this.w / 2) / after) % 1 + 1) % 1;
      this.camera.y = clamp(mapY - (y - this.h / 2) / after, .01, .99);
      this.draw();
      this.onZoom(this.camera.zoom);
    }
    fit() {
      const list = this.visibleData;
      if (!list.length) { this.camera = { x: xy(-50, -15).x, y: xy(-50, -15).y, zoom: 1.4 }; this.draw(); return; }
      const projected = list.map(item => xy(item._location.lon, item._location.lat));
      const xList = projected.map(p => p.x).sort((a,b) => a-b);
      // Escolhe o menor intervalo, inclusive cruzando a linha internacional de data.
      let maxGap = -1, gapIndex = 0;
      for (let i = 0; i < xList.length; i++) {
        const current = xList[i];
        const next = i === xList.length - 1 ? (xList[0] ?? 0) + 1 : xList[i+1];
        if (current === undefined || next === undefined) continue;
        const gap = next - current;
        if (gap > maxGap) { maxGap = gap; gapIndex = i; }
      }
      const start = xList[(gapIndex + 1) % xList.length] ?? 0;
      const spanX = 1 - maxGap;
      const ys = projected.map(p => p.y);
      const minY = Math.min(...ys), maxY = Math.max(...ys);
      const spanY = maxY - minY;
      const zoomX = Math.log2((this.w - 105) / (TILE * Math.max(spanX, .00001)));
      const zoomY = Math.log2((this.h - 105) / (TILE * Math.max(spanY, .00001)));
      this.camera.x = (start + spanX / 2) % 1;
      this.camera.y = clamp((minY + maxY) / 2, .01, .99);
      this.camera.zoom = clamp(Math.min(zoomX,zoomY), .5, 16.5);
      this.draw();
    }
    focus(item: MapEncounter) {
      if (!item?._location) return;
      const point = xy(item._location.lon, item._location.lat);
      this.camera.x = point.x; this.camera.y = point.y;
      this.selectedItem = item;
      this.camera.zoom = Math.max(this.camera.zoom, 16.7);
      this.draw();
    }
    draw() {
      if (!this.w || !this.h || !this.ctx) return;
      const c = this.ctx, w = this.w, h = this.h;
      c.fillStyle = '#18191c'; c.fillRect(0,0,w,h);
      const glow = c.createRadialGradient(w*.56,h*.33,10,w*.55,h*.45,Math.max(w,h)*.9);
      glow.addColorStop(0,'#27282c'); glow.addColorStop(1,'#18191c'); c.fillStyle=glow;c.fillRect(0,0,w,h);
      if (this.mode === 'tecnico') this.drawGrid(c);
      this.drawCountries(c); // Base local exibida também quando os tiles estão indisponíveis.
      if (this.mode === 'geografico') this.drawMapTiles(c);
      this.drawMarkers(c);
      this.drawSelectedPair(c);
      c.fillStyle='#a1a3aa'; c.font='10px Inter,system-ui,sans-serif'; c.textAlign='right';
      const mid=latlon(this.camera.x,this.camera.y);
      c.fillText(`${mid.lat.toFixed(3)}°, ${mid.lon.toFixed(3)}°  •  Z${this.camera.zoom.toFixed(1)}`,w-16,h-18);
      this.drawScale();
    }
    // Tiles OSM são carregados exclusivamente para a área visível e durante interação real.
    // Não há pré-download em massa, servidor proxy, geocodificação nem envio de pares/IDs.
    scheduleRepaint() {
      if (this.repaintQueued) return;
      this.repaintQueued = true;
      requestAnimationFrame(() => { this.repaintQueued = false; this.draw(); });
    }
    setTileStatus(status: TileStatus) {
      if (this.lastStatus === status) return;
      this.lastStatus = status;
      this.tileStatus = status;
      this.onTileStatus(status);
    }
    drawMapTiles(c: CanvasRenderingContext2D) {
      if (!this.data.length) { this.setTileStatus('idle'); return; }
      const tileZoom = clamp(Math.floor(this.camera.zoom + 1), 0, 19);
      const count = 2 ** tileZoom;
      const size = this.worldScale() / count;
      const originX = this.w / 2 - this.camera.x * this.worldScale();
      const originY = this.h / 2 - this.camera.y * this.worldScale();
      const left = Math.floor(-originX / size);
      const right = Math.floor((this.w - originX) / size);
      const top = Math.max(0, Math.floor(-originY / size));
      const bottom = Math.min(count - 1, Math.floor((this.h - originY) / size));
      let pending = 0, loaded = 0, failed = 0;
      c.save();
      c.filter = 'grayscale(0.95) invert(0.90) hue-rotate(180deg) brightness(0.80) contrast(1.1)';
      for (let y = top; y <= bottom; y++) {
        for (let x = left; x <= right; x++) {
          const wrapped = ((x % count) + count) % count;
          const key = `${tileZoom}/${wrapped}/${y}`;
          let tile = this.tileCache.get(key);
          if (!tile) {
            tile = { state: 'loading', image: new Image() };
            this.tileCache.set(key, tile);
            // Limite de memória: não solicita outras escalas/áreas previamente.
            if (this.tileCache.size > 160) {
              const oldest = this.tileCache.keys().next().value;
              if (oldest !== undefined && oldest !== key) this.tileCache.delete(oldest);
            }
            const requestedTile = tile;
            const image = requestedTile.image;
            image.referrerPolicy = 'strict-origin-when-cross-origin';
            tile.image = image;
            image.onload = () => { requestedTile.state = 'loaded'; this.scheduleRepaint(); };
            image.onerror = () => { requestedTile.state = 'error'; this.scheduleRepaint(); };
            image.src = `https://tile.openstreetmap.org/${key}.png`;
          }
          if (tile.state === 'loaded') {
            loaded++;
            c.drawImage(tile.image, originX + x * size, originY + y * size, size + 0.6, size + 0.6);
          } else if (tile.state === 'error') failed++;
          else pending++;
        }
      }
      c.restore();
      if (loaded) this.setTileStatus('ready');
      else if (pending) this.setTileStatus('loading');
      else if (failed) this.setTileStatus('unavailable');
    }
    drawSelectedPair(c: CanvasRenderingContext2D) {
      const item = this.selectedItem;
      if (!item || this.camera.zoom < 14.5 || !this.visibleData.some(v => v._key === item._key)) return;
      const [a, b] = item.monitoradosEncontro;
      const pA = item.posicoes[a], pB = item.posicoes[b];
      if (!pA || !pB) return;
      const A = this.project(pA.lon, pA.lat), B = this.project(pB.lon, pB.lat);
      if (Math.abs(A.x - B.x) > this.w + 100) return;
      const pxPerMeter = this.worldScale() / (2 * Math.PI * 6371000 * Math.max(.01, Math.cos(rad(pA.lat))));
      const radius = 20 * pxPerMeter;
      c.save();
      c.beginPath(); c.arc(A.x, A.y, radius, 0, TAU);
      c.fillStyle = '#e74a521d'; c.fill(); c.strokeStyle = '#e74a5299'; c.setLineDash([4, 4]); c.lineWidth = 1.4; c.stroke();
      c.setLineDash([]); c.beginPath(); c.moveTo(A.x, A.y); c.lineTo(B.x, B.y);
      c.strokeStyle = '#f7edef'; c.lineWidth = 2; c.stroke();
      for (const [pos, id, color] of [[A, a, '#f24c55'], [B, b, '#dddde2']] as const) {
        c.beginPath(); c.arc(pos.x, pos.y, 6, 0, TAU); c.fillStyle = color; c.fill();
        c.strokeStyle = '#151517'; c.lineWidth = 2; c.stroke();
        c.font = '700 11px Inter,system-ui,sans-serif'; c.textAlign = 'left';
        c.fillStyle = '#fff'; c.strokeStyle = '#131316'; c.lineWidth = 3;
        c.strokeText(`ID ${id}`, pos.x + 9, pos.y - 9);
        c.fillText(`ID ${id}`, pos.x + 9, pos.y - 9);
      }
      c.restore();
    }
    drawGrid(c: CanvasRenderingContext2D) {
      const z=this.camera.zoom, step = z < 2 ? 30 : z < 4 ? 10 : z < 7 ? 2 : z < 11 ? .25 : .02;
      c.save(); c.strokeStyle='#414247'; c.lineWidth=.7; c.setLineDash([2,6]);
      const mid=latlon(this.camera.x,this.camera.y);
      const latitudeMin=clamp(mid.lat-80/Math.pow(2,Math.max(0,z-1)), -85, 85);
      const latitudeMax=clamp(mid.lat+80/Math.pow(2,Math.max(0,z-1)), -85, 85);
      const spanLon=360 * (this.w/this.worldScale());
      const firstLon=Math.ceil((mid.lon-spanLon/2)/step)*step;
      for(let lon=firstLon;lon<=mid.lon+spanLon/2+step;lon+=step){
        const p=this.project(((lon+180)%360+360)%360-180,0);
        if(p.x<-1||p.x>this.w+1)continue;
        c.beginPath();c.moveTo(p.x,0);c.lineTo(p.x,this.h);c.stroke();
      }
      const firstLat=Math.ceil(latitudeMin/step)*step;
      for(let lat=firstLat;lat<=latitudeMax;lat+=step){
        const y=this.project(mid.lon,lat).y;
        if(y<-1||y>this.h+1)continue;
        c.beginPath();c.moveTo(0,y);c.lineTo(this.w,y);c.stroke();
      }
      c.restore();
    }
    drawCountries(c: CanvasRenderingContext2D) {
      if (!this.countries.length) return;
      c.save(); c.fillStyle='#303135';c.strokeStyle='#4c4d52';c.lineWidth=.8;
      for (const country of this.countries) {
        for (const ring of country.r) {
          if (ring.length < 3) continue;
          c.beginPath();
          let drawn=false;
          let first: Point | null = null, prev: Point | null = null;
          for (const coord of ring) {
            const p=this.project(coord[0],coord[1]);
            if (prev && Math.abs(prev.x-p.x)>this.worldScale()*.5) { // Quebra ao cruzar a linha internacional de data.
              c.closePath(); c.fill(); c.stroke(); c.beginPath(); first=null;
            }
            if (!first) { c.moveTo(p.x,p.y); first=p; }
            else c.lineTo(p.x,p.y);
            prev=p; drawn=true;
          }
          if(drawn){c.closePath();c.fill();c.stroke();}
        }
      }
      c.restore();
    }
    drawMarkers(c: CanvasRenderingContext2D) {
      this.hitTargets = [];
      const visible = this.visibleData;
      if (!visible.length) return;
      const cells = new Map<string, MarkerCell>();
      for (const item of visible) {
        const p=this.project(item._location.lon,item._location.lat);
        if(p.x < -50 || p.x > this.w+50 || p.y < -50 || p.y>this.h+50)continue;
        const key=`${Math.floor(p.x/32)}:${Math.floor(p.y/32)}`;
        let cell = cells.get(key);
        if (!cell) { cell = { x: 0, y: 0, items: [], counts: {} }; cells.set(key, cell); }
        cell.x+=p.x;cell.y+=p.y;cell.items.push(item);cell.counts[item.tipo]=(cell.counts[item.tipo]||0)+1;
      }
      c.save();
      for(const cell of cells.values()){
        const n=cell.items.length, x=cell.x/n,y=cell.y/n;
        const mainType = Object.keys(cell.counts)
          .filter((type): type is TipoEncontro => type === 'generico' || type === 'faccao' || type === 'protetiva')
          .sort((a,b) => (cell.counts[b] ?? 0) - (cell.counts[a] ?? 0))[0] ?? 'generico';
        const color=COLORS[mainType] || '#e5e5e8'; const radius=n>1?17:10;
        c.shadowColor=n>1?'#f0444b65':color+'90';c.shadowBlur=22;
        c.beginPath();c.arc(x,y,radius+5,0,TAU);c.fillStyle='#f0444b26';c.fill();
        c.shadowBlur=0;c.beginPath();c.arc(x,y,radius,0,TAU);
        c.fillStyle=n>1?'#303033':'#232326';c.fill();c.strokeStyle=color;c.lineWidth=2.2;c.stroke();
        if(n>1){c.fillStyle='#ffffff';c.font='700 11px Inter,system-ui,sans-serif';c.textAlign='center';c.textBaseline='middle';c.fillText(n>999?'999+':String(n),x,y+1);}
        else{c.beginPath();c.arc(x,y,3.8,0,TAU);c.fillStyle=color;c.fill();}
        this.hitTargets.push({x,y,radius:radius+9,items:cell.items});
      }
      c.restore();
    }
    drawScale() {
      const display=document.getElementById('map-scale');
      if(!display)return;
      const center=latlon(this.camera.x,this.camera.y);
      const metersPerPixel=Math.cos(rad(center.lat)) * 2*Math.PI * 6371000 / this.worldScale();
      const meters=Math.round(metersPerPixel * 100);
      display.textContent=meters>=1000?`~ ${Math.round(meters/1000).toLocaleString('pt-BR')} km / 100 px`:`~ ${meters.toLocaleString('pt-BR')} m / 100 px`;
    }
    hit(x: number,y: number) { return [...this.hitTargets].reverse().find(p => Math.hypot(x-p.x,y-p.y)<p.radius); }
    hideTooltip() { this.tooltip.hidden=true; }
    showTooltip(hit: HitTarget | undefined,x: number,y: number) {
      if(!hit){this.hideTooltip();return;}
      const item=hit.items[0];
      if (!item) { this.hideTooltip(); return; }
      const names={generico:'Genérico',faccao:'Facção',protetiva:'Medida protetiva'};
      const [a,b]=item.monitoradosEncontro;
      this.tooltip.replaceChildren();
      const title=document.createElement('strong');title.textContent=hit.items.length>1?`${hit.items.length} encontros nesta região`:`${names[item.tipo]||item.tipo} · IDs ${a} e ${b}`;
      const sub=document.createElement('span');sub.textContent=hit.items.length>1?'Clique para aproximar e explorar':`${item.timestamp} · ${item.distanciaMetros.toFixed(2)} m`;
      this.tooltip.append(title,sub); this.tooltip.hidden=false;
      const margin=12,tw=this.tooltip.offsetWidth,th=this.tooltip.offsetHeight;
      this.tooltip.style.left=`${clamp(x+14,margin,this.w-tw-margin)}px`;
      this.tooltip.style.top=`${clamp(y-th-12,margin,this.h-th-margin)}px`;
    }
    setupInteractions() {
      const parent=this.parent;
      this.canvas.addEventListener('pointerdown', e => {
        if(e.button!==0)return;
        this.canvas.setPointerCapture(e.pointerId);
        this.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
        this.drag={x:e.clientX,y:e.clientY,moved:false};
        this.hideTooltip();
        this.canvas.style.cursor='grabbing';
      });
      this.canvas.addEventListener('pointermove', e => {
        const current=this.pointers.get(e.pointerId);
        if(current){
          const dx=e.clientX-current.x,dy=e.clientY-current.y;
          this.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
          if(this.drag && Math.hypot(e.clientX-this.drag.x,e.clientY-this.drag.y)>3)this.drag.moved=true;
          if(this.pointers.size===1)this.panBy(dx,dy);
        }else{
          const rect=this.canvas.getBoundingClientRect();const x=e.clientX-rect.left,y=e.clientY-rect.top;
          const hit=this.hit(x,y);this.canvas.style.cursor=hit?'pointer':'grab';
          this.showTooltip(hit,x,y);
        }
      });
      const finish=(e: PointerEvent)=>{
        const previous=this.pointers.get(e.pointerId);
        this.pointers.delete(e.pointerId);
        this.canvas.style.cursor='grab';
        if(previous&&this.drag&&!this.drag.moved){
          const rect=this.canvas.getBoundingClientRect();const hit=this.hit(e.clientX-rect.left,e.clientY-rect.top);
          if(hit){
            if(hit.items.length>1&&this.camera.zoom<15){this.zoomBy(2,hit.x,hit.y);}
            else if (hit.items[0]) this.onSelect(hit.items[0]);
          }
        }
        this.drag=null;
      };
      this.canvas.addEventListener('pointerup',finish);
      this.canvas.addEventListener('pointercancel',e=>{this.pointers.delete(e.pointerId);this.drag=null;this.canvas.style.cursor='grab';});
      this.canvas.addEventListener('pointerleave',()=>this.hideTooltip());
      parent.addEventListener('wheel',e=>{
        if(e.target!==this.canvas)return;
        e.preventDefault();const rect=this.canvas.getBoundingClientRect();
        this.zoomBy(e.deltaY<0?.35:-.35,e.clientX-rect.left,e.clientY-rect.top);
      },{passive:false});
      parent.addEventListener('keydown',e=>{
        if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-'].includes(e.key)){
          e.preventDefault();
          if(e.key==='+'||e.key==='=')this.zoomBy(.5);
          else if(e.key==='-')this.zoomBy(-.5);
          else this.panBy(e.key==='ArrowLeft'?70:e.key==='ArrowRight'?-70:0,e.key==='ArrowUp'?70:e.key==='ArrowDown'?-70:0);
        }
      });
    }
  }
  window.EncounterMap=EncounterMap;

