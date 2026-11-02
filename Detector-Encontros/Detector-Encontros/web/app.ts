import { EncounterMap, type MapMode } from './map.js';
import type { Encontro, TipoEncontro, DatasetInspection, ComparacaoGabarito, JobSummary, ResultsResponse, MapResponse, InspectResponse, ProcessResponse, JobsResponse, HealthResponse, ProcessingLimits } from '../src/types.js';

type InspectionState = { status: 'pending' | 'checking' } | (DatasetInspection & { status: 'valid' | 'invalid' });
interface InterfaceState {
  map: EncounterMap | null;
  mapItems: Encontro[];
  mapSample: MapResponse | null;
  mapLimit: number;
  mapRequest: AbortController | null;
  files: File[];
  inspections: Map<string, InspectionState>;
  inspectionQueue: File[];
  inspecting: boolean;
  limits: ProcessingLimits | null;
  jobs: JobSummary[];
  reports: Map<string, ComparacaoGabarito>;
  activeId: string | null;
  page: number;
  limit: number;
  total: number;
  processing: boolean;
  request: AbortController | null;
  searchTimer: ReturnType<typeof setTimeout> | null;
  currentRows: Encontro[];
  referenceFile: File | null;
}
const ENCOUNTER_TYPES: readonly TipoEncontro[] = ['generico', 'faccao', 'protetiva'];
const elementTags = {
  "app-shell": "div",
  "sidebar-overlay": "div",
  "sidebar": "aside",
  "sidebar-toggle": "button",
  "server-status": "span",
  "top-server-status": "span",
  "mobile-menu": "button",
  "current-section": "strong",
  "processamento": "section",
  "file-input": "input",
  "dropzone": "div",
  "upload-limit": "small",
  "file-list": "div",
  "preflight-overview": "div",
  "preflight-records": "strong",
  "preflight-times": "strong",
  "preflight-people": "strong",
  "generic-policy": "select",
  "processing-mode": "select",
  "process-btn": "button",
  "progress-region": "div",
  "progress-label": "span",
  "progress-fill": "div",
  "donut": "div",
  "donut-total": "strong",
  "legend-generic": "strong",
  "legend-faction": "strong",
  "legend-protect": "strong",
  "datasets-count": "strong",
  "time-total": "strong",
  "visao-geral": "section",
  "stat-total": "div",
  "stat-generic": "div",
  "stat-faction": "div",
  "stat-protect": "div",
  "mapa": "section",
  "map-heading": "h2",
  "map-geographic": "button",
  "map-technical": "button",
  "map-counter": "span",
  "map-fit": "button",
  "map-area": "div",
  "encounter-map": "canvas",
  "map-location-label": "div",
  "map-layer-status": "span",
  "map-zoom-in": "button",
  "map-zoom-out": "button",
  "map-reset": "button",
  "map-empty": "div",
  "map-tooltip": "div",
  "map-scale": "div",
  "map-attribution": "div",
  "map-aside-count": "span",
  "map-type-filter": "select",
  "map-encounter-list": "div",
  "map-hint": "span",
  "desempenho": "section",
  "performance-context": "span",
  "perf-records": "strong",
  "perf-potential": "strong",
  "perf-candidates": "strong",
  "perf-candidate-method": "small",
  "perf-haversine": "strong",
  "perf-time": "strong",
  "perf-reduction": "strong",
  "perf-bar": "div",
  "perf-explanation": "small",
  "resultados": "section",
  "download-btn": "a",
  "download-all": "a",
  "dataset-activity": "div",
  "dataset-select": "select",
  "type-filter": "select",
  "search-input": "input",
  "results-body": "tbody",
  "page-info": "span",
  "prev-page": "button",
  "page-label": "span",
  "next-page": "button",
  "validacao": "section",
  "reference-name": "span",
  "reference-file": "input",
  "compare-btn": "button",
  "compare-result": "div",
  "drawer-backdrop": "div",
  "detail-drawer": "aside",
  "drawer-close": "button",
  "drawer-type": "div",
  "drawer-ids": "h3",
  "drawer-time": "strong",
  "drawer-distance": "strong",
  "geo-svg": "svg",
  "geo-connecting": "line",
  "geo-point-1": "circle",
  "geo-point-2": "circle",
  "geo-label-1": "text",
  "geo-label-2": "text",
  "drawer-positions": "div",
  "toast": "div"
} as const;
type TagElement<T extends string> = T extends keyof HTMLElementTagNameMap ? HTMLElementTagNameMap[T]
  : T extends keyof SVGElementTagNameMap ? SVGElementTagNameMap[T] : never;
function $<K extends keyof typeof elementTags>(id: K): TagElement<(typeof elementTags)[K]> {
  const element = document.getElementById(id);
  const tag = elementTags[id];
  if (!element || element.localName !== tag) throw new Error(`Elemento de interface ausente ou inválido: ${id}`);
  // The tag is checked before returning its corresponding DOM element type.
  return element as TagElement<(typeof elementTags)[K]>;
}
function closestTarget(event: Event, selector: string): HTMLElement | null {
  const element = event.target instanceof Element ? event.target.closest(selector) : null;
  return element instanceof HTMLElement ? element : null;
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'Erro inesperado.'; }
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isFiniteNumber(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function isStrings(value: unknown): value is string[] { return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string'); }
function isTipoEncontro(value: unknown): value is TipoEncontro { return value === 'generico' || value === 'faccao' || value === 'protetiva'; }
function isEncontro(value: unknown): value is Encontro {
  if (!isObject(value) || !isTipoEncontro(value.tipo) || typeof value.timestamp !== 'string' || !isFiniteNumber(value.distanciaMetros)) return false;
  const ids: unknown = value.monitoradosEncontro;
  const positions = value.posicoes;
  if (!Array.isArray(ids) || ids.length !== 2 || ids[0] === ids[1] || !isObject(positions)) return false;
  return ids.every((id: unknown) => {
    if (typeof id !== 'number' || !Number.isSafeInteger(id)) return false;
    const position = positions[String(id)];
    return isObject(position) && isFiniteNumber(position.lat) && isFiniteNumber(position.lon) && Math.abs(position.lat) <= 90 && Math.abs(position.lon) <= 180;
  });
}
function isEncounters(value: unknown): value is Encontro[] { return Array.isArray(value) && value.every(isEncontro); }
function isInspection(value: unknown): value is DatasetInspection {
  if (!isObject(value)) return false;
  return typeof value.valid === 'boolean' && typeof value.headerPresent === 'boolean'
    && ['count', 'duplicated', 'timestamps', 'uniqueIds', 'errorCount'].every(key => isFiniteNumber(value[key]))
    && (value.firstTimestamp === null || typeof value.firstTimestamp === 'string')
    && (value.lastTimestamp === null || typeof value.lastTimestamp === 'string') && isStrings(value.issues)
    && Array.isArray(value.sample) && value.sample.every((row: unknown) => isObject(row) && isFiniteNumber(row.id) && typeof row.timestamp === 'string'
      && isFiniteNumber(row.lat) && isFiniteNumber(row.lon) && typeof row.medidaProtetiva === 'boolean');
}
function isJobSummary(value: unknown): value is JobSummary {
  if (!isObject(value) || typeof value.id !== 'string' || typeof value.filename !== 'string' || typeof value.createdAt !== 'string') return false;
  const counts = value.byType, metrics = value.performanceMetrics;
  return ['size', 'count', 'duplicated', 'timestamps', 'encounters', 'durationMs'].every(key => isFiniteNumber(value[key]))
    && isObject(counts) && ENCOUNTER_TYPES.every(key => isFiniteNumber(counts[key]))
    && isObject(metrics) && ['potentialPairs', 'candidatePairs', 'haversineCalculations', 'directGroups', 'spatialGroups'].every(key => isFiniteNumber(metrics[key]));
}
function isComparison(value: unknown): value is ComparacaoGabarito {
  if (!isObject(value) || !isObject(value.issues)) return false;
  const issues = value.issues;
  return ['expected', 'actual', 'correct', 'incorrect', 'missing', 'approximateScore'].every(key => isFiniteNumber(value[key]))
    && ['missing', 'extra', 'wrongType', 'wrongPosition', 'wrongDistance', 'duplicate'].every(key => isStrings(issues[key]));
}
function isInspectResponse(value: unknown): value is InspectResponse { return isObject(value) && typeof value.filename === 'string' && isFiniteNumber(value.size) && isInspection(value.inspection); }
function isProcessResponse(value: unknown): value is ProcessResponse { return isObject(value) && isJobSummary(value.job); }
function isJobsResponse(value: unknown): value is JobsResponse { return isObject(value) && Array.isArray(value.jobs) && value.jobs.every(isJobSummary); }
function isResultsResponse(value: unknown): value is ResultsResponse {
  return isObject(value) && isEncounters(value.items) && ['total', 'offset', 'limit'].every(key => isFiniteNumber(value[key]));
}
function isMapResponse(value: unknown): value is MapResponse {
  return isObject(value) && isEncounters(value.items) && isFiniteNumber(value.total) && isFiniteNumber(value.displayed) && typeof value.sampled === 'boolean';
}
function isCompareResponse(value: unknown): value is { report: ComparacaoGabarito } { return isObject(value) && isComparison(value.report); }
function isHealthResponse(value: unknown): value is HealthResponse {
  if (!isObject(value) || value.status !== 'ok' || !isObject(value.limits)) return false;
  const limits = value.limits;
  return ['maxUploadBytes', 'maxRecords', 'maxConcurrentJobs', 'requestTimeoutMs'].every(key =>
    typeof limits[key] === 'number' && Number.isSafeInteger(limits[key]) && limits[key] > 0);
}


const number = new Intl.NumberFormat('pt-BR');
const decimal = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });
const state: InterfaceState = { map: null, mapItems: [], mapSample: null, mapLimit: 8, mapRequest: null, files: [], inspections: new Map(), inspectionQueue: [], inspecting: false, limits: null, jobs: [], reports: new Map(), activeId: null, page: 0, limit: 10, total: 0, processing: false, request: null, searchTimer: null, currentRows: [], referenceFile: null };
const TYPES: Record<TipoEncontro, string> = { generico: 'Genérico', faccao: 'Facção', protetiva: 'Protetiva' };
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let lastDrawerFocus: HTMLElement | null = null;

function icon(name: string) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}
function flash(message: string, error = false) {
  const box = $('toast'); box.textContent = message;
  box.classList.toggle('error', error); box.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => box.hidden = true, error ? 7000 : 3400);
}
function bytes(v: number) {
  if (v >= 1073741824) return `${decimal.format(v / 1073741824)} GiB`;
  return v < 1048576 ? `${decimal.format(v / 1024)} KB` : `${decimal.format(v / 1048576)} MB`;
}
function ms(v: number) { return v < 1000 ? `${decimal.format(v)} ms` : `${decimal.format(v / 1000)} s`; }
function filenameShort(v: string) { return v.length > 48 ? v.slice(0, 45) + '…' : v; }
function fileKey(file: File) { return [file.name, file.size, file.lastModified].join('::'); }
function activeJob() { return state.jobs.find(job => job.id === state.activeId) || null; }
async function getJSON<T>(url: string, validate: (value: unknown) => value is T, options?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(url, options); }
  catch (error) {
    if (options?.signal?.aborted) throw error;
    throw new Error('A conexão com o servidor foi interrompida. Confirme que ele está em execução e tente novamente.');
  }
  let payload: unknown;
  try { payload = await response.json(); }
  catch { throw new Error(`Servidor retornou resposta inválida (${response.status}).`); }
  if (!response.ok) throw new Error(isObject(payload) && typeof payload.error === 'string' ? payload.error : `Erro HTTP ${response.status}.`);
  if (!validate(payload)) throw new Error('Servidor retornou dados incompatíveis com o contrato esperado.');
  return payload;
}
let limitsRequest: Promise<ProcessingLimits> | null = null;
async function loadServerLimits(): Promise<ProcessingLimits> {
  if (state.limits) return state.limits;
  if (!limitsRequest) {
    limitsRequest = getJSON('/api/health', isHealthResponse).then(result => {
      state.limits = result.limits;
      return result.limits;
    }).finally(() => { limitsRequest = null; });
  }
  return limitsRequest;
}
function validateUploadSize(file: File, limits: ProcessingLimits): void {
  if (file.size > limits.maxUploadBytes) {
    throw new Error(`${file.name} tem ${bytes(file.size)} e excede o limite de ${bytes(limits.maxUploadBytes)} por arquivo configurado no servidor. O arquivo não foi enviado.`);
  }
}
function buttonState() {
  const statuses = state.files.map(f => state.inspections.get(fileKey(f)));
  $('process-btn').disabled = state.processing || !statuses.length || statuses.some(s => s?.status !== 'valid');
  $('file-input').disabled = state.processing;
}
function addFiles(files: Iterable<File>) {
  let rejected = 0;
  for (const file of files) {
    if (!file.name.toLowerCase().endsWith('.txt')) { rejected++; continue; }
    if (state.files.some(f => fileKey(f) === fileKey(file))) continue;
    state.files.push(file);
    queueInspection(file);
  }
  if (rejected) flash(`${rejected} arquivo(s) ignorado(s): somente .txt.`, true);
  renderFiles();
}
function queueInspection(file: File): void {
  if (!state.files.includes(file)) return;
  const key = fileKey(file);
  const status = state.inspections.get(key)?.status;
  if (status === 'pending' || status === 'checking') return;
  state.inspections.set(key, { status: 'pending' });
  state.inspectionQueue.push(file);
  void inspectQueue();
}
async function inspectQueue(): Promise<void> {
  if (state.inspecting) return;
  state.inspecting = true;
  try {
    let file: File | undefined;
    while ((file = state.inspectionQueue.shift()) !== undefined) {
      if (state.files.includes(file)) await inspectSelected(file);
    }
  } finally { state.inspecting = false; }
}
async function inspectSelected(file: File): Promise<void> {
  const key = fileKey(file);
  const checking: InspectionState = { status: 'checking' };
  state.inspections.set(key, checking);
  renderFiles();
  try {
    const limits = await loadServerLimits();
    if (!state.files.includes(file) || state.inspections.get(key) !== checking) return;
    validateUploadSize(file, limits);
    const result = await getJSON(`/api/inspect?filename=${encodeURIComponent(file.name)}`, isInspectResponse, { method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: file });
    if (!state.files.includes(file) || state.inspections.get(key) !== checking) return;
    state.inspections.set(key, { status: result.inspection.valid ? 'valid' : 'invalid', ...result.inspection });
  } catch (error) {
    if (!state.files.includes(file) || state.inspections.get(key) !== checking) return;
    state.inspections.set(key, { status: 'invalid', valid: false, count: 0, duplicated: 0, timestamps: 0, uniqueIds: 0, firstTimestamp: null, lastTimestamp: null, headerPresent: false, issues: [errorMessage(error)], errorCount: 1, sample: [] });
  }
  renderFiles();
}
function renderFiles() {
  const list = $('file-list'); list.replaceChildren();
  for (const [index, file] of state.files.entries()) {
    const info = state.inspections.get(fileKey(file)) || { status: 'pending' };
    const item = document.createElement('div'); item.className = 'selected-file'; item.append(icon('file'));
    const nameBox = document.createElement('div'); nameBox.className = 'file-text';
    const strong = document.createElement('strong'); strong.textContent = file.name; strong.title = file.name;
    const size = document.createElement('small'); size.textContent = bytes(file.size);
    nameBox.append(strong, size); item.append(nameBox);
    const status = document.createElement('span'); status.className = `file-status ${info.status === 'valid' ? 'valid' : info.status === 'invalid' ? 'invalid' : 'pending'}`;
    status.textContent = info.status === 'valid' ? '✓ Validado' : info.status === 'invalid' ? '✕ Corrigir' : '● Validando'; item.append(status);
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove-file'; remove.dataset.remove = String(index); remove.title = 'Remover arquivo'; remove.setAttribute('aria-label', `Remover ${file.name}`); remove.append(icon('close')); item.append(remove);
    list.append(item);
    if (info.status === 'invalid') {
      const error = document.createElement('div'); error.className = 'file-issue';
      const title = document.createElement('strong'); title.textContent = `${number.format(info.errorCount || 1)} problema(s) encontrado(s):`; error.append(title);
      for (const message of (info.issues || []).slice(0, 4)) {
        const p = document.createElement('div'); p.textContent = message; error.append(p);
      }
      const rerun = document.createElement('button'); rerun.className = 'detail-button'; rerun.type = 'button'; rerun.dataset.reinspect = String(index); rerun.textContent = 'Verificar novamente'; rerun.style.marginTop = '9px'; error.append(rerun);
      list.append(error);
    }
  }
  const accepted = state.files.map(f => state.inspections.get(fileKey(f))).filter((v): v is DatasetInspection & { status: 'valid' } => v?.status === 'valid');
  $('preflight-overview').hidden = !accepted.length;
  if (accepted.length) {
    $('preflight-records').textContent = number.format(accepted.reduce((a, v) => a + v.count, 0));
    $('preflight-times').textContent = number.format(accepted.reduce((a, v) => a + v.timestamps, 0));
    $('preflight-people').textContent = number.format(accepted.reduce((a, v) => a + v.uniqueIds, 0));
  }
  buttonState();
}
function busy(value: boolean, message = '') {
  state.processing = value; buttonState();
  $('progress-region').hidden = !value;
  $('process-btn').replaceChildren(document.createTextNode(value ? 'Processando...' : 'Processar arquivos'));
  if (!value) $('process-btn').append(icon('arrow'));
  if (value) $('progress-label').textContent = message;
}
async function processFiles() {
  if (state.processing || $('process-btn').disabled) return;
  const queue = [...state.files]; const failures: File[] = [];
  let completed = 0, lastId = null;
  busy(true, `Iniciando ${queue.length} arquivo(s)...`);
  for (const [index, file] of queue.entries()) {
    $('progress-label').textContent = `${file.name} · ${index + 1}/${queue.length}`;
    $('progress-fill').style.width = `${index / queue.length * 100}%`;
    const q = new URLSearchParams({ filename: file.name, genericPolicy: $('generic-policy').value, mode: $('processing-mode').value });
    try {
      validateUploadSize(file, await loadServerLimits());
      const { job } = await getJSON(`/api/process?${q}`, isProcessResponse, { method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: file });
      completed++; lastId = job.id;
    } catch (error) {
      failures.push(file);
      flash(`Falha em ${file.name}: ${errorMessage(error)}`, true);
    }
    $('progress-fill').style.width = `${(index + 1) / queue.length * 100}%`;
  }
  state.files = failures;
  state.inspections = new Map(failures.map(f => [fileKey(f), state.inspections.get(fileKey(f)) ?? { status: 'pending' }]));
  busy(false); renderFiles(); await loadJobs(lastId);
  if (completed) {
    flash(`${completed} dataset(s) processado(s).`);
    $('resultados').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}
function updateTotals() {
  const sums = { generico: 0, faccao: 0, protetiva: 0, encounters: 0, time: 0 };
  for (const j of state.jobs) {
    sums.encounters += j.encounters; sums.time += j.durationMs;
    for (const t of ENCOUNTER_TYPES) sums[t] += j.byType[t];
  }
  $('stat-total').textContent = number.format(sums.encounters);
  $('stat-generic').textContent = number.format(sums.generico);
  $('stat-faction').textContent = number.format(sums.faccao);
  $('stat-protect').textContent = number.format(sums.protetiva);
  $('donut-total').textContent = number.format(sums.encounters);
  $('datasets-count').textContent = number.format(state.jobs.length);
  $('time-total').textContent = ms(sums.time);
  const percent = (type: TipoEncontro) => sums.encounters ? Math.round(100 * sums[type] / sums.encounters) : 0;
  for (const type of ENCOUNTER_TYPES) $(type === 'generico' ? 'legend-generic' : type === 'faccao' ? 'legend-faction' : 'legend-protect').textContent = `${percent(type)}%`;
  const g = sums.encounters ? sums.generico * 100 / sums.encounters : 0;
  const f = sums.encounters ? sums.faccao * 100 / sums.encounters : 0;
  $('donut').style.background = sums.encounters ? `conic-gradient(#c9cbd2 0% ${g}%, #c0787c ${g}% ${g+f}%, #fa535b ${g+f}% 100%)` : '#37373c';
  const zip = $('download-all');
  zip.classList.toggle('disabled-link', state.jobs.length === 0);
  zip.setAttribute('aria-disabled', String(!state.jobs.length));
  zip.href = state.jobs.length ? '/api/download-all' : '#resultados';
}
function updatePerformance() {
  const job = activeJob(); const perf = job?.performanceMetrics;
  $('performance-context').textContent = job ? job.filename : 'Selecione um dataset processado';
  $('perf-records').textContent = job ? number.format(job.count) : '—';
  $('perf-potential').textContent = perf ? number.format(perf.potentialPairs) : '—';
  $('perf-candidates').textContent = perf ? number.format(perf.candidatePairs) : '—';
  const direct = (perf?.directGroups ?? 0) > 0;
  const spatial = (perf?.spatialGroups ?? 0) > 0;
  $('perf-candidate-method').textContent = direct && spatial ? 'Comparação direta e seleção espacial'
    : direct ? 'Comparação direta entre pares' : spatial ? 'Após seleção espacial' : 'Conforme a estratégia do motor';
  $('perf-haversine').textContent = perf ? number.format(perf.haversineCalculations) : '—';
  $('perf-time').textContent = job ? ms(job.durationMs) : '—';
  const reduction = perf && perf.potentialPairs > 0 ? Math.max(0, 100 * (1 - perf.candidatePairs / perf.potentialPairs)) : 0;
  $('perf-reduction').textContent = perf?.potentialPairs ? (reduction > 99.99 && reduction < 100 ? '> 99,99%' : `${decimal.format(reduction)}%`) : '—';
  $('perf-bar').style.width = `${reduction}%`;
  const strategy = perf && (direct || spatial)
    ? `${number.format(perf.directGroups)} horários com comparação direta e ${number.format(perf.spatialGroups)} com seleção espacial. ` : '';
  $('perf-explanation').textContent = job && perf
    ? `${number.format(job.count)} registros lidos integralmente. ${strategy}De ${number.format(perf.potentialPairs)} pares no mesmo horário, ${number.format(perf.candidatePairs)} foram avaliados como candidatos. A redução é de comparações, sem remover registros ou encontros do resultado.`
    : 'A seleção espacial reduz comparações de distância. Todos os registros são analisados e os encontros confirmados permanecem no JSON.';
}
function renderJobs() {
  const area = $('dataset-activity'); area.replaceChildren();
  const select = $('dataset-select'); select.replaceChildren();
  if (!state.jobs.length) {
    const blank = document.createElement('div'); blank.className = 'no-datasets'; blank.textContent = 'Nenhum dataset processado ainda.'; area.append(blank);
    const option = document.createElement('option'); option.value = ''; option.textContent = 'Nenhum arquivo'; select.add(option);
  }
  for (const job of state.jobs) {
    const option = document.createElement('option'); option.value = job.id; option.textContent = job.filename; select.add(option);
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'dataset-tile'; btn.dataset.jobId = job.id;
    btn.classList.toggle('selected', job.id === state.activeId); btn.append(icon('file'));
    const body = document.createElement('div'); body.style.minWidth = '0';
    const title = document.createElement('strong'); title.textContent = filenameShort(job.filename); title.title = job.filename;
    const subtitle = document.createElement('small'); subtitle.textContent = `${number.format(job.encounters)} encontros · ${ms(job.durationMs)}`;
    body.append(title, subtitle); btn.append(body); area.append(btn);
  }
  const present = Boolean(activeJob());
  select.disabled = !present;
  select.value = present ? state.activeId ?? '' : '';
  $('type-filter').disabled = !present; $('search-input').disabled = !present;
  const json = $('download-btn'); json.classList.toggle('disabled-link', !present);
  json.setAttribute('aria-disabled', String(!present));
  json.href = present ? `/api/jobs/${state.activeId}/download` : '#resultados';
  $('compare-btn').disabled = !present || !state.referenceFile;
  updatePerformance(); renderComparison(state.activeId ? state.reports.get(state.activeId) : undefined);
}
function emptyTable(title: string, description = '') {
  const body = $('results-body'); body.replaceChildren();
  const row = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = 5; td.className = 'table-empty';
  const heading = document.createElement('strong'); heading.textContent = title;
  const subtitle = document.createElement('span'); subtitle.textContent = description;
  td.append(heading, subtitle); row.append(td); body.append(row);
}
function renderTable(items: Encontro[]) {
  state.currentRows = items;
  if (!items.length) { emptyTable('Nenhum encontro encontrado', 'Ajuste a pesquisa ou selecione outro dataset.'); return; }
  const body = $('results-body'); body.replaceChildren();
  for (const [index, result] of items.entries()) {
    const row = document.createElement('tr');
    const type = document.createElement('td'); const pill = document.createElement('span'); pill.className = `type-badge type-${result.tipo}`; pill.textContent = TYPES[result.tipo] || result.tipo; type.append(pill);
    const persons = document.createElement('td'); const pair = document.createElement('div'); pair.className = 'ids-pair';
    const first = document.createElement('strong'); first.textContent = String(result.monitoradosEncontro[0]);
    const middle = document.createElement('span'); middle.textContent = '↔';
    const second = document.createElement('strong'); second.textContent = String(result.monitoradosEncontro[1]);
    pair.append(first, middle, second); persons.append(pair);
    const time = document.createElement('td'); time.className = 'timestamp'; time.textContent = result.timestamp;
    const dist = document.createElement('td'); dist.className = 'distance'; dist.textContent = `${decimal.format(result.distanciaMetros)} m`; dist.title = String(result.distanciaMetros);
    const details = document.createElement('td');
    const show = document.createElement('button'); show.type = 'button'; show.className = 'detail-button'; show.textContent = 'Inspecionar'; show.dataset.inspect = String(index);
    details.append(show); row.append(type, persons, time, dist, details); body.append(row);
  }
}
function updatePage() {
  const begin = state.total ? state.page * state.limit + 1 : 0;
  const end = Math.min(state.total, (state.page + 1) * state.limit);
  $('page-info').textContent = `${number.format(begin)}–${number.format(end)} de ${number.format(state.total)} resultado(s)`;
  $('page-label').textContent = state.total ? `${state.page + 1}/${Math.ceil(state.total / state.limit)}` : '—';
  $('prev-page').disabled = !activeJob() || state.page === 0;
  $('next-page').disabled = !activeJob() || end >= state.total;
}
async function loadResults() {
  if (state.request) state.request.abort();
  const job = activeJob();
  if (!job) { state.total = state.page = 0; emptyTable('Aguardando sua primeira análise', 'Importe um arquivo .txt para visualizar os encontros.'); updatePage(); return; }
  const controller = new AbortController(); state.request = controller;
  const q = new URLSearchParams({ limit: String(state.limit), offset: String(state.page * state.limit) });
  if ($('type-filter').value) q.set('type', $('type-filter').value);
  if ($('search-input').value.trim()) q.set('search', $('search-input').value.trim());
  try {
    const payload = await getJSON(`/api/jobs/${job.id}/results?${q}`, isResultsResponse, { signal: controller.signal });
    if (controller.signal.aborted) return;
    state.total = payload.total; renderTable(payload.items); updatePage();
  } catch (err) {
    if (controller.signal.aborted) return;
    emptyTable('Não foi possível buscar resultados', errorMessage(err)); flash(errorMessage(err), true);
  }
}
function selectJob(id: string) {
  if (!state.jobs.some(job => job.id === id)) return;
  state.activeId = id; state.page = 0;
  $('type-filter').value = ''; $('search-input').value = '';
  // Gabaritos são vinculados ao dataset atual e nunca reutilizados sem nova seleção.
  state.referenceFile = null; $('reference-file').value = ''; $('reference-name').textContent = 'Selecionar gabarito .json';
  renderJobs(); loadResults(); loadMap();
}
async function loadJobs(preferredId?: string | null) {
  try {
    const { jobs } = await getJSON('/api/jobs', isJobsResponse); state.jobs = jobs;
    if (preferredId && jobs.some(j => j.id === preferredId)) state.activeId = preferredId;
    else if (!jobs.some(j => j.id === state.activeId)) state.activeId = jobs.at(-1)?.id || null;
    updateTotals(); renderJobs(); await Promise.all([loadResults(), loadMap()]);
  } catch (error) { flash(`Falha ao consultar o servidor: ${errorMessage(error)}`, true); }
}
function renderComparison(report: ComparacaoGabarito | undefined) {
  const place = $('compare-result'); place.replaceChildren();
  if (!report) {
    place.style.display = 'flex';
    const empty = document.createElement('div'); empty.className = 'compare-empty';
    empty.append(icon('check'));
    const heading = document.createElement('strong'); heading.textContent = 'Aguardando validação';
    const message = document.createElement('span'); message.textContent = 'Selecione um gabarito para comparar com o resultado.';
    empty.append(heading, message); place.append(empty); return;
  }
  place.style.display = 'block';
  const stats = document.createElement('div'); stats.className = 'comparison-stats';
  for (const [label, value, cls] of [['Corretos',report.correct,'correct'], ['Incorretos',report.incorrect,'incorrect'], ['Ausentes',report.missing,'missing'], ['Score aprox.',report.approximateScore,'']] as const) {
    const tile = document.createElement('div'); const strong = document.createElement('strong'); strong.className = cls; strong.textContent = number.format(value);
    const caption = document.createElement('span'); caption.textContent = label; tile.append(strong,caption); stats.append(tile);
  }
  place.append(stats);
  const problems = Object.entries(report.issues).flatMap(([name, arr]) => arr.map(line => `${name}: ${line}`));
  const info = document.createElement('p'); info.style.cssText = 'font-size:10px;margin:13px 0 0';
  info.textContent = `${number.format(report.actual)} gerado(s), ${number.format(report.expected)} no gabarito. ${problems.length ? 'Veja as divergências abaixo.' : 'Nenhuma divergência detectada.'}`;
  place.append(info);
  if (problems.length) {
    const det = document.createElement('details'); det.className = 'comparison-details'; const sum = document.createElement('summary'); sum.textContent = `Consultar divergências (amostra)`; det.append(sum);
    const ul = document.createElement('ul'); for (const problem of problems.slice(0, 40)) { const li = document.createElement('li'); li.textContent = problem; ul.append(li); }
    det.append(ul); place.append(det);
  }
}
async function compareReference() {
  const job = activeJob(); const file = state.referenceFile;
  if (!job || !file) return;
  $('compare-btn').disabled = true; $('compare-btn').textContent = 'Comparando...';
  try {
    const json = await file.text();
    JSON.parse(json); // mensagem imediata para JSON inválido
    const { report } = await getJSON(`/api/jobs/${job.id}/compare`, isCompareResponse, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json });
    state.reports.set(job.id, report); renderComparison(report);
    flash(report.incorrect === 0 && report.missing === 0 ? 'Resultado compatível com o gabarito!' : 'Comparação concluída: verifique as divergências.');
  } catch (error) { flash(`Erro na comparação: ${errorMessage(error)}`, true); }
  finally { $('compare-btn').textContent = 'Comparar resultados'; $('compare-btn').append(icon('arrow')); $('compare-btn').disabled = !activeJob() || !state.referenceFile; }
}
function inspectResult(row: Encontro | undefined, focusElement: Element | null) {
  if (!row) return;
  lastDrawerFocus = focusElement instanceof HTMLElement ? focusElement : null;
  const drawer = $('detail-drawer'), backdrop = $('drawer-backdrop');
  const first = row.monitoradosEncontro[0], second = row.monitoradosEncontro[1];
  const a = row.posicoes[first], b = row.posicoes[second];
  if (!a || !b) { flash('As posições do encontro estão incompletas.', true); return; }
  const type = $('drawer-type'); type.replaceChildren(); const pill = document.createElement('span'); pill.className = `type-badge type-${row.tipo}`; pill.textContent = TYPES[row.tipo] || row.tipo; type.append(pill);
  $('drawer-ids').textContent = `ID ${first}  ↔  ID ${second}`;
  $('drawer-time').textContent = row.timestamp;
  $('drawer-distance').textContent = `${row.distanciaMetros.toFixed(9)} m`;
  const positions = $('drawer-positions'); positions.replaceChildren();
  for (const [id, pos] of [[first,a],[second,b]] as const) {
    const box = document.createElement('div'); box.className = 'drawer-position';
    const label = document.createElement('strong'); label.textContent = `Monitorado ${id}`;
    const coords = document.createElement('code'); coords.textContent = `Latitude: ${pos.lat} · Longitude: ${pos.lon}`;
    box.append(label,coords); positions.append(box);
  }
  // Projeção plana local apenas ilustrativa, ancorada em A (o cálculo oficial é Haversine).
  const r = 6371000, rad = Math.PI / 180;
  const north = (b.lat - a.lat) * rad * r;
  let lngDiff = (b.lon - a.lon + 540) % 360 - 180;
  const east = lngDiff * rad * r * Math.cos((a.lat + b.lat) / 2 * rad);
  const x1 = 160, y1 = 110, scale = 68 / 20;
  const x2 = Math.max(14, Math.min(306, x1 + east * scale));
  const y2 = Math.max(14, Math.min(206, y1 - north * scale));
  $('geo-point-1').setAttribute('cx', String(x1)); $('geo-point-1').setAttribute('cy', String(y1));
  $('geo-point-2').setAttribute('cx', String(x2)); $('geo-point-2').setAttribute('cy', String(y2));
  $('geo-connecting').setAttribute('x1', String(x1)); $('geo-connecting').setAttribute('y1', String(y1));
  $('geo-connecting').setAttribute('x2', String(x2)); $('geo-connecting').setAttribute('y2', String(y2));
  $('geo-label-1').textContent = `ID ${first}`; $('geo-label-2').textContent = `ID ${second}`;
  $('geo-label-1').setAttribute('x', String(x1 + 10)); $('geo-label-1').setAttribute('y', String(y1 - 10));
  $('geo-label-2').setAttribute('x', String(x2 + 10)); $('geo-label-2').setAttribute('y', String(y2 - 10));
  backdrop.hidden = false; requestAnimationFrame(() => { backdrop.classList.add('open'); drawer.classList.add('open'); });
  drawer.setAttribute('aria-hidden', 'false'); $('drawer-close').focus();
}
function closeDrawer() {
  const drawer = $('detail-drawer'), backdrop = $('drawer-backdrop');
  drawer.classList.remove('open'); backdrop.classList.remove('open'); drawer.setAttribute('aria-hidden', 'true');
  backdrop.hidden = true; lastDrawerFocus?.focus();
}

// Mapa: amostra independente da paginação da tabela; clicável e responsivo.
function setupMap() {
  const map = new EncounterMap($('encounter-map'), $('map-tooltip'));
  state.map = map;
  map.onSelect = item => { map.focus(item); inspectResult(item, document.activeElement); };
  map.onTileStatus = status => {
    if (map.mode !== 'geografico') return;
    const labels = {
      idle: 'GEOGRÁFICO · CONECTE UM DATASET', loading: 'CARREGANDO MAPA GEOGRÁFICO…',
      ready: 'OPENSTREETMAP · ESTADOS E CIDADES', unavailable: 'MAPA ONLINE INDISPONÍVEL · BASE LOCAL'
    };
    $('map-layer-status').textContent = labels[status] || 'MAPA GEOGRÁFICO';
  };
  const applyMode = (mode: MapMode) => {
    map.setMode(mode);
    $('map-geographic').classList.toggle('active', mode === 'geografico');
    $('map-technical').classList.toggle('active', mode === 'tecnico');
    $('map-geographic').setAttribute('aria-pressed', String(mode === 'geografico'));
    $('map-technical').setAttribute('aria-pressed', String(mode === 'tecnico'));
    $('map-attribution').hidden = mode !== 'geografico';
    if (mode === 'tecnico') $('map-layer-status').textContent = 'BASE VETORIAL · OFFLINE';
    else map.onTileStatus(map.tileStatus);
    try { localStorage.setItem('detector-map-mode', mode); } catch {}
  };
  $('map-geographic').addEventListener('click', () => applyMode('geografico'));
  $('map-technical').addEventListener('click', () => applyMode('tecnico'));
  try { if (localStorage.getItem('detector-map-mode') === 'tecnico') applyMode('tecnico'); } catch {}
  $('map-zoom-in').addEventListener('click', () => map.zoomBy(.7));
  $('map-zoom-out').addEventListener('click', () => map.zoomBy(-.7));
  $('map-reset').addEventListener('click', () => map.fit());
  $('map-fit').addEventListener('click', () => map.fit());
  $('map-type-filter').addEventListener('change', event => {
    state.mapLimit = 8;
    const value = $('map-type-filter').value;
    map.setFilter(isTipoEncontro(value) ? value : '');
    renderMapList();
  });
  $('map-encounter-list').addEventListener('click', event => {
    const more = closestTarget(event, '[data-map-more]');
    if (more) { state.mapLimit += 12; renderMapList(); return; }
    const trigger = closestTarget(event, '[data-map-index]');
    if (!trigger) return;
    const item = map.visibleData[Number(trigger.dataset.mapIndex)];
    if (!item) return;
    map.focus(item);
    inspectResult(item, trigger);
  });
}
function renderMapList() {
  const node = $('map-encounter-list'); node.replaceChildren();
  const items = state.map?.visibleData || [];
  $('map-aside-count').textContent = number.format(items.length);
  if (!items.length) {
    const blank = document.createElement('div'); blank.className = 'map-list-empty';
    blank.textContent = state.mapItems.length ? 'Nenhum encontro desta categoria.' : 'Os encontros serão listados após o processamento.';
    node.append(blank); return;
  }
  const labels = { generico: 'Genérico', faccao: 'Facção', protetiva: 'Protetiva' };
  for (let index = 0; index < Math.min(items.length, state.mapLimit); index++) {
    const item = items[index];
    if (!item) continue;
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'map-list-item';
    btn.dataset.mapIndex = String(index); btn.title = 'Localizar no mapa e inspecionar';
    const top = document.createElement('span'); top.className = 'map-list-top';
    const persons = document.createElement('span'); persons.textContent = `ID ${item.monitoradosEncontro[0]}  ↔  ${item.monitoradosEncontro[1]}`;
    const type = document.createElement('span'); type.className = `type-badge type-${item.tipo}`; type.textContent = labels[item.tipo];
    top.append(persons,type);
    const time = document.createElement('span'); time.className = 'map-list-time';
    time.textContent = item.timestamp;
    const dist = document.createElement('span'); dist.className = 'map-list-distance';
    dist.textContent = `Distância: ${decimal.format(item.distanciaMetros)} m`;
    btn.append(top,time,dist);node.append(btn);
  }
  if (items.length > state.mapLimit) {
    const more = document.createElement('button'); more.type = 'button'; more.dataset.mapMore = '1';
    more.className = 'map-list-more';
    more.textContent = `Mostrar mais (${number.format(items.length - state.mapLimit)} restantes)`;
    node.append(more);
  }
}
async function loadMap() {
  if (state.mapRequest) state.mapRequest.abort();
  const job = activeJob();
  const controller = new AbortController(); state.mapRequest = controller;
  if (!job) {
    state.mapItems = []; state.mapSample = null;
    state.map?.setData([]);
    $('map-empty').hidden = false;
    $('map-counter').textContent = 'Nenhum resultado';
    $('map-hint').textContent = 'Selecione um marcador para ver os detalhes';
    renderMapList(); return;
  }
  $('map-counter').textContent = 'Carregando dados geográficos...';
  try {
    const sample = await getJSON(`/api/jobs/${job.id}/map`, isMapResponse, { signal: controller.signal });
    if (controller.signal.aborted || activeJob()?.id !== job.id) return;
    state.mapItems = sample.items;
    state.mapSample = sample;
    $('map-empty').hidden = Boolean(sample.items.length);
    $('map-counter').textContent = `${number.format(sample.displayed)} de ${number.format(sample.total)} encontros`;
    $('map-hint').textContent = sample.sampled
      ? 'Visualização amostral distribuída no dataset · Exportação JSON mantém todos os encontros'
      : 'Enquadrar, aproximar e inspecionar · Cidades/estados conforme nível de zoom';
    state.mapLimit = 8;
    state.map?.setData(sample.items);
    renderMapList();
  } catch (error) {
    if (controller.signal.aborted) return;
    $('map-counter').textContent = 'Mapa indisponível';
    flash(`Não foi possível carregar o mapa: ${errorMessage(error)}`, true);
  }
}
function setupNavigation() {
  const mobile = () => window.matchMedia('(max-width:760px)').matches;
  const overlay = $('sidebar-overlay');
  const setMobileOpen = (open: boolean) => {
    document.body.classList.toggle('menu-open', open);
    overlay.hidden = !open;
    $('mobile-menu').setAttribute('aria-expanded', String(open));
    $('mobile-menu').setAttribute('aria-label', open ? 'Fechar menu' : 'Abrir menu');
  };
  const setCollapsed = (collapsed: boolean) => {
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    $('sidebar-toggle').setAttribute('aria-expanded', String(!collapsed));
    $('sidebar-toggle').setAttribute('aria-label', collapsed ? 'Expandir menu' : 'Recolher menu');
    try { localStorage.setItem('detector-menu-collapsed', String(collapsed)); } catch {}
    state.map?.resize();
  };
  try { if (localStorage.getItem('detector-menu-collapsed') === 'true') setCollapsed(true); } catch {}
  $('sidebar-toggle').addEventListener('click', () => setCollapsed(!document.body.classList.contains('sidebar-collapsed')));
  $('mobile-menu').addEventListener('click', () => setMobileOpen(!document.body.classList.contains('menu-open')));
  overlay.addEventListener('click', () => setMobileOpen(false));
  window.addEventListener('resize', () => { if (!mobile()) setMobileOpen(false); });
  const sections = [...document.querySelectorAll<HTMLAnchorElement>('.nav-link')]
    .map(link => ({ link, section: document.querySelector<HTMLElement>(link.getAttribute('href') || '#processamento') }))
    .filter((item): item is { link: HTMLAnchorElement; section: HTMLElement } => item.section !== null);
  let activeLink: HTMLAnchorElement | null = null;
  const activate = (link: HTMLAnchorElement) => {
    if (activeLink === link) return;
    activeLink = link;
    for (const { link: nav } of sections) {
      nav.classList.toggle('active', nav === link);
      if (nav === link) nav.setAttribute('aria-current', 'location');
      else nav.removeAttribute('aria-current');
    }
    $('current-section').textContent = link.querySelector('span')?.textContent || 'Importar dataset';
  };
  const syncSection = () => {
    if (document.body.classList.contains('menu-open')) return;
    const line = (document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 60) + 24;
    let current = sections[0];
    for (const entry of sections) {
      // Scrolling rounds to device pixels, while layout positions retain fractions.
      if (entry.section.getBoundingClientRect().top <= line + 1) current = entry;
    }
    // The last section may be too short to reach the header at the page bottom.
    if (window.scrollY > 0 && Math.ceil(window.scrollY + window.innerHeight) >= document.documentElement.scrollHeight - 2) {
      current = sections[sections.length - 1];
    }
    if (current) activate(current.link);
  };
  let scheduled = false;
  const queueSync = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; syncSection(); });
  };
  for (const {link} of sections) {
    link.addEventListener('click', () => { if (mobile()) setMobileOpen(false); queueSync(); });
  }
  window.addEventListener('scroll', queueSync, { passive: true });
  window.addEventListener('resize', queueSync);
  window.addEventListener('hashchange', queueSync);
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(queueSync);
    const content = document.querySelector('.content');
    if (content) observer.observe(content);
  }
  syncSection();
  return { setMobileOpen };
}

function wireEvents() {
  document.querySelectorAll('[data-open-file]').forEach(button => button.addEventListener('click', () => $('file-input').click()));
  $('file-input').addEventListener('change', () => { const input = $('file-input'); addFiles(input.files ?? []); input.value = ''; });
  $('dropzone').addEventListener('click', () => { if (!state.processing) $('file-input').click(); });
  $('dropzone').addEventListener('keydown', event => { if ((event.key === 'Enter' || event.key === ' ') && !state.processing) { event.preventDefault(); $('file-input').click(); } });
  for (const kind of ['dragover','dragenter']) $('dropzone').addEventListener(kind, e => { e.preventDefault(); $('dropzone').classList.add('dragover'); });
  for (const kind of ['dragleave','drop']) $('dropzone').addEventListener(kind, e => { e.preventDefault(); $('dropzone').classList.remove('dragover'); });
  $('dropzone').addEventListener('drop', event => { if (!state.processing) addFiles(event.dataTransfer?.files ?? []); });
  $('file-list').addEventListener('click', event => {
    const remove = closestTarget(event, '[data-remove]');
    const rerun = closestTarget(event, '[data-reinspect]');
    if (state.processing) return;
    if (remove) {
      const [f] = state.files.splice(Number(remove.dataset.remove), 1);
      if (f) state.inspections.delete(fileKey(f)); renderFiles();
    }
    if (rerun) { const file = state.files[Number(rerun.dataset.reinspect)]; if (file) queueInspection(file); }
  });
  $('process-btn').addEventListener('click', processFiles);
  $('dataset-activity').addEventListener('click', event => { const target = closestTarget(event, '[data-job-id]'); if (target?.dataset.jobId) selectJob(target.dataset.jobId); });
  $('dataset-select').addEventListener('change', () => selectJob($('dataset-select').value));
  $('type-filter').addEventListener('change', () => { state.page = 0; loadResults(); });
  $('search-input').addEventListener('input', () => { if (state.searchTimer !== null) clearTimeout(state.searchTimer); state.searchTimer = setTimeout(() => { state.page = 0; loadResults(); }, 250); });
  $('prev-page').addEventListener('click', () => { if (state.page > 0) { state.page--; loadResults(); } });
  $('next-page').addEventListener('click', () => { if ((state.page+1)*state.limit < state.total) { state.page++; loadResults(); } });
  $('results-body').addEventListener('click', event => { const b = closestTarget(event, '[data-inspect]'); if (b) inspectResult(state.currentRows[Number(b.dataset.inspect)], b); });
  $('drawer-close').addEventListener('click', closeDrawer); $('drawer-backdrop').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { if ($('detail-drawer').classList.contains('open')) closeDrawer(); else if (document.body.classList.contains('menu-open')) { $('mobile-menu').click(); $('mobile-menu').focus(); } } });
  $('reference-file').addEventListener('change', event => {
    state.referenceFile = $('reference-file').files?.[0] ?? null;
    $('reference-name').textContent = state.referenceFile?.name || 'Selecionar gabarito .json';
    $('compare-btn').disabled = !activeJob() || !state.referenceFile;
  });
  $('compare-btn').addEventListener('click', compareReference);
  for (const key of ['download-btn','download-all'] as const) $(key).addEventListener('click', event => { if ($(key).getAttribute('aria-disabled') === 'true') event.preventDefault(); });
}
async function init() {
  setupMap(); setupNavigation(); wireEvents();
  try {
    const limits = await loadServerLimits();
    $('upload-limit').textContent = `CSV separado por ponto e vírgula · Até ${bytes(limits.maxUploadBytes)} por arquivo · ${number.format(limits.maxRecords)} registros. Arquivos grandes podem levar alguns minutos para validar.`;
    document.querySelector('.system-status')?.classList.add('online');
    $('server-status').textContent = 'Motor operacional';
    $('top-server-status').textContent = 'Motor operacional';
    document.querySelector('.build-pill')?.classList.add('online');
  } catch {
    $('server-status').textContent = 'Servidor indisponível';
    $('top-server-status').textContent = 'Sem conexão';
    $('upload-limit').textContent = 'Não foi possível consultar o limite de upload. Inicie ou atualize o servidor e tente novamente.';
  }
  await loadJobs();
}
init();
