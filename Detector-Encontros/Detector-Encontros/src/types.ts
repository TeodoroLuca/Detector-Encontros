/** Contratos compartilhados; o JSON oficial contém apenas Encontro[]. */
export type TipoEncontro = 'generico' | 'faccao' | 'protetiva';
export type PoliticaEncontroGenerico = 'all' | 'tornozeleiras';
export type ModoProcessamento = 'unordered' | 'sorted';
export interface PosicaoGeografica { lat: number; lon: number }
export interface Monitorado extends PosicaoGeografica {
  id: number;
  faccao: string;
  timestamp: string;
  medidaProtetiva: boolean;
  idsRestricaoMedida: ReadonlySet<number>;
}
export interface Encontro {
  tipo: TipoEncontro;
  monitoradosEncontro: [number, number];
  timestamp: string;
  posicoes: Record<string, PosicaoGeografica>;
  distanciaMetros: number;
}
export interface MetricasProcessamento {
  potentialPairs: number;
  candidatePairs: number;
  haversineCalculations: number;
  directGroups: number;
  spatialGroups: number;
}
export interface ResultadoProcessamento {
  count: number;
  duplicated: number;
  encounters: number;
  byType: Record<TipoEncontro, number>;
  timestamps: number;
  durationMs: number;
  output: string;
  wroteArray: boolean;
  performanceMetrics: MetricasProcessamento;
}
export interface DatasetInspection {
  valid: boolean;
  count: number;
  duplicated: number;
  timestamps: number;
  uniqueIds: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  headerPresent: boolean;
  errorCount: number;
  issues: string[];
  sample: Pick<Monitorado, 'id' | 'timestamp' | 'lat' | 'lon' | 'medidaProtetiva'>[];
}
export interface ComparacaoGabarito {
  expected: number;
  actual: number;
  correct: number;
  incorrect: number;
  missing: number;
  approximateScore: number;
  issues: Record<'missing' | 'extra' | 'wrongType' | 'wrongPosition' | 'wrongDistance' | 'duplicate', string[]>;
}
export interface ProcessingJob extends ResultadoProcessamento {
  id: string;
  filename: string;
  size: number;
  createdAt: string;
}
export type JobSummary = Omit<ProcessingJob, 'output' | 'wroteArray'>;
export interface ProcessRequest { filename: string; genericPolicy: PoliticaEncontroGenerico; mode: ModoProcessamento }
export interface ResultsRequest { offset: number; limit: number; type: TipoEncontro | ''; search: string }
export interface ResultsResponse { items: Encontro[]; total: number; offset: number; limit: number }
export interface MapResponse { items: Encontro[]; total: number; sampled: boolean; displayed: number }
export interface InspectResponse { filename: string; size: number; inspection: DatasetInspection }
export interface ProcessResponse { job: JobSummary }
export interface JobsResponse { jobs: JobSummary[] }
export interface CompareResponse { report: ComparacaoGabarito }
export interface ErrorResponse { error: string }
/** Limites efetivos publicados antes do upload para a interface validar o arquivo. */
export interface ProcessingLimits {
  maxUploadBytes: number;
  maxRecords: number;
  maxConcurrentJobs: number;
  requestTimeoutMs: number;
}
export interface HealthResponse { status: 'ok'; limits: ProcessingLimits }
