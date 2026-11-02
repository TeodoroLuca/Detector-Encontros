import type { Encontro, MetricasProcessamento, Monitorado, PoliticaEncontroGenerico, PosicaoGeografica, TipoEncontro } from './types.js';

export const RAIO_TERRA_METROS = 6_371_000;
export const DISTANCIA_LIMITE_METROS = 20;
const GRAUS_PARA_RADIANOS = Math.PI / 180;

/** Distância geodésica, em metros, calculada exclusivamente por Haversine. */
export function haversine(a: PosicaoGeografica, b: PosicaoGeografica): number {
  const phi1 = a.lat * GRAUS_PARA_RADIANOS;
  const phi2 = b.lat * GRAUS_PARA_RADIANOS;
  const deltaPhi = (b.lat - a.lat) * GRAUS_PARA_RADIANOS;
  const deltaLambda = (b.lon - a.lon) * GRAUS_PARA_RADIANOS;
  const sinPhi = Math.sin(deltaPhi / 2);
  const sinLambda = Math.sin(deltaLambda / 2);
  const h = sinPhi * sinPhi + Math.cos(phi1) * Math.cos(phi2) * sinLambda * sinLambda;
  return 2 * RAIO_TERRA_METROS * Math.atan2(Math.sqrt(Math.max(0, h)), Math.sqrt(Math.max(0, 1 - h)));
}

/** Mantém as políticas do motor original e a precedência protetiva > faccao > generico. */
export function classifyPair(a: Monitorado, b: Monitorado, genericPolicy: PoliticaEncontroGenerico = 'all'): TipoEncontro | null {
  if (a.medidaProtetiva !== b.medidaProtetiva) {
    const vitima = a.medidaProtetiva ? a : b;
    const agressor = a.medidaProtetiva ? b : a;
    if (vitima.idsRestricaoMedida.has(agressor.id)) return 'protetiva';
  }
  if (!a.medidaProtetiva && !b.medidaProtetiva && a.faccao !== '' && a.faccao === b.faccao) return 'faccao';
  if (genericPolicy === 'all') return 'generico';
  if (genericPolicy === 'tornozeleiras') return (!a.medidaProtetiva && !b.medidaProtetiva) ? 'generico' : null;
  throw new Error(`Política genérica inválida: ${genericPolicy}`);
}

function ecef(p: PosicaoGeografica): [number, number, number] {
  const phi = p.lat * GRAUS_PARA_RADIANOS;
  const lambda = p.lon * GRAUS_PARA_RADIANOS;
  const rCosPhi = RAIO_TERRA_METROS * Math.cos(phi);
  return [rCosPhi * Math.cos(lambda), rCosPhi * Math.sin(lambda), RAIO_TERRA_METROS * Math.sin(phi)];
}

function createEncounter(a: Monitorado, b: Monitorado, tipo: TipoEncontro, distanciaMetros: number): Encontro {
  return {
    tipo,
    monitoradosEncontro: [a.id, b.id],
    timestamp: a.timestamp,
    posicoes: { [a.id]: { lat: a.lat, lon: a.lon }, [b.id]: { lat: b.lat, lon: b.lon } },
    distanciaMetros
  };
}

function* quadratic(rows: Monitorado[], genericPolicy: PoliticaEncontroGenerico, metrics: MetricasProcessamento | undefined): Generator<Encontro> {
  for (const [i, a] of rows.entries()) {
    for (let j = i + 1; j < rows.length; j++) {
      // j é limitado pelo tamanho do array, que não é modificado durante a iteração.
      const b = rows[j]!;
      if (metrics) metrics.candidatePairs++;
      const tipo = classifyPair(a, b, genericPolicy);
      if (!tipo) continue;
      if (metrics) metrics.haversineCalculations++;
      const dist = haversine(a, b);
      if (dist < DISTANCIA_LIMITE_METROS) yield createEncounter(a, b, tipo, dist);
    }
  }
}

/**
 * Uma corda ECEF de um arco <20 m também é <20 m. Células cúbicas de 20 m
 * e suas 26 vizinhas incluem todo candidato, inclusive polos e antimeridiano.
 * A decisão final continua exclusivamente com Haversine.
 */
function* spatialHash(rows: Monitorado[], genericPolicy: PoliticaEncontroGenerico, metrics: MetricasProcessamento | undefined): Generator<Encontro> {
  // Index each axis separately: skip empty x/y slabs before visiting z cells.
  // Numeric keys avoid allocating 27 coordinate strings for every position.
  const cells = new Map<number, Map<number, Map<number, Monitorado[]>>>();
  const cellSize = DISTANCIA_LIMITE_METROS;
  for (const current of rows) {
    const xyz = ecef(current);
    const coords: [number, number, number] = [Math.floor(xyz[0] / cellSize), Math.floor(xyz[1] / cellSize), Math.floor(xyz[2] / cellSize)];
    for (let dx = -1; dx <= 1; dx++) {
      const plane = cells.get(coords[0] + dx);
      if (!plane) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const column = plane.get(coords[1] + dy);
        if (!column) continue;
        for (let dz = -1; dz <= 1; dz++) {
          const others = column.get(coords[2] + dz);
          if (!others) continue;
          for (const older of others) {
            if (metrics) metrics.candidatePairs++;
            const tipo = classifyPair(older, current, genericPolicy);
            if (!tipo) continue;
            if (metrics) metrics.haversineCalculations++;
            const dist = haversine(older, current);
            if (dist < DISTANCIA_LIMITE_METROS) yield createEncounter(older, current, tipo, dist);
          }
        }
      }
    }
    let plane = cells.get(coords[0]);
    if (!plane) cells.set(coords[0], plane = new Map());
    let column = plane.get(coords[1]);
    if (!column) plane.set(coords[1], column = new Map());
    let list = column.get(coords[2]);
    if (!list) column.set(coords[2], list = []);
    list.push(current);
  }
}

export interface DetectionOptions {
  genericPolicy?: PoliticaEncontroGenerico;
  bruteForceThreshold?: number;
  metrics?: MetricasProcessamento;
}

/** Recebe um único timestamp, previamente deduplicado por identidade pelo processamento. */
export function* detectGroup(records: Iterable<Monitorado>, { genericPolicy = 'all', bruteForceThreshold = 64, metrics }: DetectionOptions = {}): Generator<Encontro> {
  const rows = [...records].sort((a, b) => a.id - b.id);
  if (metrics) {
    metrics.potentialPairs += rows.length * (rows.length - 1) / 2;
    if (rows.length > bruteForceThreshold) metrics.spatialGroups++;
    else metrics.directGroups++;
  }
  if (rows.length <= bruteForceThreshold) yield* quadratic(rows, genericPolicy, metrics);
  else yield* spatialHash(rows, genericPolicy, metrics);
}
