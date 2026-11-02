# Detector de Encontros 1.0.0

Aplicação local em TypeScript e Node.js para detectar encontros entre pessoas no mesmo horário, com distância Haversine inferior a 20 metros. Inclui interface web, processamento por terminal, mapas, filtros e exportação JSON.

A [documentação dos códigos fonte](Documentacao-Codigo-Fonte.docx) explica os nove módulos de `src/`, suas funções principais, os contratos e o fluxo completo de processamento.

## Stack utilizada

O código-fonte da aplicação é escrito em **TypeScript**, tanto no backend (`src/`) quanto no frontend (`web/`). O compilador usa modo estrito, módulos ES e alvo ES2022.

| Camada | Tecnologias |
|---|---|
| Linguagem da aplicação | TypeScript 5.9.3, com verificação estrita de tipos |
| Backend e CLI | Node.js 22 ou superior, com módulos nativos para HTTP, arquivos e streams |
| Frontend | TypeScript, HTML, CSS e APIs nativas do navegador, sem framework de interface |
| Mapas | Canvas, cartografia vetorial local e tiles opcionais do OpenStreetMap |
| Build e dependências | Compilador TypeScript (`tsc`) e npm, com versões fixadas no lockfile |
| Testes | Ferramentas nativas `node:test` e `node:assert/strict` |
| Dados | Entrada TXT e saída JSON, com arquivos temporários durante o processamento; sem banco de dados |

O build compila os fontes `.ts` para JavaScript em `dist/`: o Node.js executa o backend compilado, e o navegador executa o frontend compilado. Os scripts auxiliares de automação e os testes usam arquivos JavaScript `.mjs` e `.js`. O backend não utiliza dependências externas de runtime.

## Como executar o projeto

Requer **Node.js 22 ou superior, com npm**, em Windows, Linux ou macOS. Os iniciadores usam o Node.js instalado e os arquivos desta pasta. Na primeira execução, se faltarem dependências, eles executam `npm ci`, que requer acesso à internet. Nas execuções seguintes, com as dependências instaladas, a preparação e o modo de mapa Técnico funcionam offline.

### Opção 1: iniciador na pasta do projeto

**Windows:** dê dois cliques em **`Iniciar-Detector.cmd`**. Também pode executá-lo pelo PowerShell, na pasta do projeto:

```powershell
.\Iniciar-Detector.cmd
```

**Linux e macOS:** abra um terminal na pasta do projeto e execute:

```sh
sh ./Iniciar-Detector.sh
```

Se preferir executá-lo diretamente, conceda permissão uma vez:

```sh
chmod +x Iniciar-Detector.sh
./Iniciar-Detector.sh
```

Os dois iniciadores verificam a versão do Node.js, instalam dependências ausentes, compilam os fontes atuais e iniciam o mesmo servidor usado pela aplicação. O navegador padrão abre somente depois que o servidor está pronto. Mantenha a janela/terminal aberta e use **Ctrl+C** para encerrar. Se o navegador não abrir automaticamente, acesse o endereço exibido no terminal, normalmente **http://127.0.0.1:3000**.

A abertura automática usa o navegador padrão do Windows, `open` no macOS e `xdg-open` no Linux. Em ambientes sem essas ferramentas ou sem interface gráfica, use a opção `--no-browser` e acesse o endereço manualmente. Os iniciadores precisam permanecer na mesma estrutura de pastas do projeto, pois usam `scripts/launch.mjs` e os fontes atuais.

### Opção 2: comando único, nos três sistemas

```sh
npm run launch
```

É o mesmo fluxo dos iniciadores. Para iniciar sem abrir o navegador, inclusive em Linux sem ambiente gráfico:

```sh
npm run launch -- --no-browser
```

Para preparar o build e verificar a API e a página em uma porta temporária, encerrando ao concluir:

```sh
npm run launch -- --check
```

As opções `--no-browser`, `--check` e `--help` também podem ser passadas aos arquivos `.cmd` e `.sh`. Se a porta estiver ocupada, encerre a instância anterior ou configure outra `PORT`, conforme a tabela de configuração abaixo.

### Opção 3: instalação, build e execução separados

No terminal, dentro da pasta do projeto:

```powershell
npm ci
npm run build
npm start
```

Abra http://127.0.0.1:3000. A interface deve ser servida pelo Node.js, não aberta como arquivo HTML local.

```powershell
npm run dev          # Compila e acompanha alterações
npm run typecheck    # Verifica os tipos do backend e do frontend
npm test             # Recompila e executa os testes
```

O runtime usa apenas módulos nativos do Node.js. TypeScript e os tipos do Node são dependências de desenvolvimento. O comando `npm start` executa o build em `dist/`; após alterar fontes, execute o build novamente ou use `npm run dev`. Recarregue o navegador após mudanças na interface.

`npm run dev` compila e acompanha alterações, mas não instala dependências nem abre o navegador automaticamente. O build copia HTML, CSS, ícone, cartografia e exemplo para `dist/`.

## Estrutura necessária

| Caminho | Uso |
|---|---|
| `src/` | Parser, agrupamento, detecção, inspeção, API, CLI, comparação e exportação |
| `web/` | Interface TypeScript, HTML, CSS, ícone e cartografia local |
| `Iniciar-Detector.cmd` | Iniciador para Windows, com dois cliques ou pelo terminal |
| `Iniciar-Detector.sh` | Iniciador para Linux e macOS |
| `scripts/` | Iniciação compartilhada, build e acompanhamento de alterações |
| `tests/` | Testes de regressão e auditoria opcional de arquivos grandes |
| `benchmarks/run.mjs` | Ferramenta de medição de desempenho |
| `datasets/dataset1.txt` | Entrada usada pela CLI padrão, pelos testes e pelo benchmark |
| `exemplos/exemplo.txt` | Exemplo oferecido pela interface e usado nos testes HTTP |
| `dist/` | Código e assets compilados necessários para `npm start` |
| `node_modules/` | Dependências instaladas necessárias para compilar e desenvolver |
| `tsconfig*.json` | Configuração TypeScript estrita para servidor e navegador |
| `package.json` e `package-lock.json` | Comandos e versões das dependências |

`outputs/` é criada quando a CLI ou a auditoria grava resultados. Os resultados e relatórios gerados são ignorados pelo Git. O projeto não precisa de JSONs históricos, baselines externos ou resultados previamente processados para funcionar ou executar os testes.

## Interface

1. Selecione um ou mais arquivos `.txt` ou arraste-os para a área de importação.
2. Aguarde a pré-validação de cabeçalho, campos, coordenadas, horários, duplicatas e conflitos.
3. Processe os arquivos e selecione o resultado desejado.
4. Use os filtros, a paginação e os detalhes para examinar os encontros.
5. Exporte o JSON individual ou os resultados da sessão em ZIP. A opção de comparar um gabarito usa um JSON fornecido pelo usuário; não depende de referências armazenadas no projeto.

O mapa **Técnico** funciona offline com a base vetorial local derivada de Natural Earth. O mapa **Geográfico** usa tiles do OpenStreetMap, requer internet e mantém a atribuição aos seus contribuidores. As requisições de tiles revelam a região visualizada ao provedor. O mapa mostra até 750 encontros e informa quando há amostragem; o JSON exportado mantém todos os encontros. O mapa não altera coordenadas nem calcula a distância oficial.

## Processamento por terminal

Execute os comandos na raiz do projeto. Antes do primeiro uso da CLI, instale as dependências com `npm ci` e gere o build com `npm run build`; esses passos também são feitos pelo iniciador. Os comandos `process` e `validate` usam `dist/` e não recompilam automaticamente.

Processar os arquivos `.txt` da pasta `datasets`:

```powershell
npm run process
```

Processar outro arquivo ou diretório, usando caminhos relativos válidos nos três sistemas:

```powershell
npm run process -- --input "dados/arquivo.txt" --output "outputs/arquivo.json"
npm run process -- --input "dados" --output outputs
```

Opções:

- `--mode unordered`: padrão; aceita horários em qualquer ordem. Verifica a ordenação em uma primeira passagem e processa um horário por vez. Quando necessário, usa ordenação externa em lotes, preservando os números das linhas e as duplicatas.
- `--mode sorted`: exige horários cronológicos e rejeita inversões.
- `--generic-policy all`: padrão; considera quaisquer duas pessoas elegíveis para encontros genéricos.
- `--generic-policy tornozeleiras`: encontros genéricos somente entre pessoas sem medida protetiva.

As políticas alteram a elegibilidade de encontros genéricos; a identificação dos vínculos de medida protetiva continua ativa em ambas. Para uma pasta de entrada, a CLI processa os arquivos `.txt` diretamente nela, sem percorrer subpastas, e gera um JSON por arquivo.

Comparar com um gabarito fornecido pelo usuário:

```powershell
npm run validate -- --reference "dados/gabarito.json" --actual "outputs/arquivo.json"
```

O comparador aceita uma diferença absoluta de até `0.000001` metro na distância. IDs, timestamp, tipo e coordenadas são conferidos sem essa tolerância. Para exigir distância exatamente igual, acrescente `--tolerance 0`. A ordem dos dois IDs do par não altera sua identidade. A CLI retorna código 0 quando não há divergências, 2 quando há diferenças e 1 em erros de execução ou entrada.

## Lógica utilizada

### 1. Ler e validar a entrada

TXT com sete colunas separadas por ponto e vírgula:

```text
idMonitorado;faccaoMonitorado;timestamp;latitude;longitude;medidaProtetiva;idsRestricaoMedida
```

- IDs são declarados como `number` em **TypeScript** e devem ser inteiros não negativos entre **0 e 9.007.199.254.740.991** (`Number.MAX_SAFE_INTEGER`), validados por `Number.isSafeInteger`. Esse é o intervalo de inteiros seguros do tipo `number`, cuja representação numérica é preservada quando o TypeScript é compilado para JavaScript.
- `timestamp` deve conter uma data e um horário válidos no formato `YYYY-MM-DD HH:mm:ss`.
- Latitude entre -90 e 90; longitude entre -180 e 180, com ponto decimal.
- `medidaProtetiva` aceita `true`, `false`, `1` ou `0`.
- Restrições contêm IDs separados por vírgula, opcionalmente entre colchetes ou aspas; podem ficar vazias.
- O parser aceita BOM, campos entre aspas e linhas vazias. A pré-validação exige cabeçalho; a CLI também aceita registros sem cabeçalho.

O arquivo é lido como UTF-8. Datas e horários são comparados como informados, sem conversão de fuso horário. Cada linha de entrada tem comprimento máximo de 1.048.576 unidades, medido por `String.length`; linhas maiores são rejeitadas.

### 2. Agrupar por horário e identificar duplicatas

Cada horário exato é processado separadamente: uma posição às `10:00:00` não é comparada com outra às `10:00:05`. Registros idênticos da mesma pessoa no mesmo horário são contados como duplicatas; posições contraditórias são rejeitadas.

Uma primeira passagem verifica os dados e a ordenação. Entradas cronológicas são lidas por grupos sequenciais; entradas fora de ordem usam ordenação externa em lotes. O processamento e a pré-validação compartilham esse fluxo para manter a mesma interpretação dos registros.

### 3. Selecionar os pares candidatos

Para até 64 pessoas distintas no mesmo horário, o motor compara diretamente os pares. Em grupos maiores, converte as posições para coordenadas cartesianas terrestres (ECEF) e usa células cúbicas de 20 metros. Para cada pessoa, procura candidatos em sua célula e nas 26 vizinhas. O índice usa chaves numéricas por eixo e pula planos e colunas vazios, evitando criar chaves de texto em cada consulta. Cada par é considerado uma única vez.

Essa seleção preserva os possíveis encontros: se o arco entre duas posições mede menos de 20 metros, a corda entre elas também mede menos de 20 metros. Portanto, as diferenças nos três eixos são menores que 20 metros, colocando os pontos na mesma célula ou em células vizinhas. A representação tridimensional também cobre polos e a passagem de longitude de +180° para -180°.

### 4. Classificar e confirmar a distância

Um encontro exige distância **estritamente menor que 20 metros**, calculada por Haversine com raio terrestre de 6.371.000 metros. O índice espacial seleciona candidatos; Haversine decide se há encontro. Exatamente 20 metros não é aceito.

Prioridade de classificação:

1. `protetiva`: uma pessoa com medida protetiva possui vínculo de restrição com a outra, sem medida protetiva.
2. `faccao`: ambas sem medida protetiva e com a mesma facção não vazia.
3. `generico`: demais pares permitidos pela política selecionada.

### 5. Gerar o resultado

O JSON contém somente `tipo`, `monitoradosEncontro`, `timestamp`, `posicoes` e `distanciaMetros`, sem arredondar artificialmente a distância. Limites ou erros interrompem o processamento; não são usados para publicar resultados truncados. A CLI grava em arquivo parcial e publica a saída somente após concluir.

## Desempenho e memória

Até 64 pessoas por horário, o motor compara todos os pares diretamente. Acima disso, usa células ECEF de 20 metros e suas vizinhas para selecionar candidatos; a decisão final continua sendo Haversine. O painel identifica qual estratégia foi usada.

- **Registros analisados:** linhas de posicionamento lidas.
- **Pares possíveis:** soma de `n × (n - 1) / 2` em cada horário.
- **Pares candidatos:** pares selecionados pela estratégia do motor.
- **Cálculos Haversine:** distâncias calculadas após a elegibilidade de tipo.
- **Redução:** diminuição do número de pares candidatos; não significa perda de registros ou encontros e não mede ganho de tempo.
- **Tempo:** processamento no backend, sem upload, pré-validação ou download.

Inspeção e processamento trabalham por horário, sem acumular todos os horários em RAM. Entradas desordenadas descarregam lotes ao atingir 50.000 registros ou 8 Mi de caracteres e fazem merge de até 16 arquivos por passagem. A memória ainda depende do maior grupo de pessoas no mesmo horário; se todo o arquivo tiver o mesmo horário, esse grupo precisará caber em memória. Temporários são limpos após conclusão, falha ou cancelamento normal.

## Por que considero esta a melhor abordagem para o problema

Considero esta combinação a mais adequada para o problema porque equilibra **exatidão dos encontros, consumo de memória, tempo de execução e simplicidade de operação**:

- **Exatidão antes de desempenho:** o agrupamento respeita o timestamp exato; a distância final é Haversine, com limite estrito; duplicatas e conflitos são tratados explicitamente. O filtro espacial reduz trabalho sem substituir a regra de encontro.
- **Estratégia híbrida:** grupos pequenos evitam o custo de montar e consultar um índice. Em grupos maiores e espalhados, as células evitam comparar pessoas distantes. Reduzir a quantidade de Haversine, por si só, não garante menor tempo; por isso o motor mantém as duas estratégias.
- **Arquivos grandes com memória controlada:** processar por horário e ordenar externamente permite trabalhar com milhões de registros sem manter todos os horários em RAM. A saída também é escrita progressivamente.
- **Uma implementação para CLI e interface:** ambas usam o mesmo parser e motor. Isso evita divergências entre o resultado mostrado na tela e o JSON exportado.
- **Operação e manutenção simples:** TypeScript estrito torna os contratos explícitos, enquanto Node.js permite executar o mesmo projeto nos três sistemas. O runtime usa módulos nativos, sem banco de dados, serviço remoto de processamento ou bibliotecas geográficas externas.
- **Resultado verificável:** testes cobrem distância limite, classificação, duplicatas, entradas fora de ordem, polos, antimeridiano, uploads e cancelamento. A auditoria opcional compara o índice com todos os pares por força bruta.

Comparar todos os pares tem custo `O(n²)` por horário. Após ordenar o grupo por ID, com custo `O(n log n)`, a seleção pelo índice tem custo esperado próximo de `O(n + k)` em distribuições esparsas, sendo `k` o número de candidatos próximos. Em grupos muito densos, ela também pode chegar ao caso quadrático, pois há muitos pares que precisam ser examinados. A ordenação externa acrescenta processamento e uso temporário de disco para aceitar arquivos desordenados. Esses custos permitem preservar as regras e processar entradas que não caberiam integralmente em RAM.

## Configuração do servidor

| Variável | Padrão | Finalidade |
|---|---:|---|
| `HOST` | `127.0.0.1` | Endereço local |
| `PORT` | `3000` | Porta HTTP |
| `MAX_UPLOAD_MB` | `10240` | Upload de até 10 GiB por arquivo; unidade MiB |
| `MAX_RECORDS` | `20000000` | Máximo de registros por arquivo |
| `MAX_CONCURRENT_JOBS` | `1` | Trabalhos simultâneos |
| `REQUEST_TIMEOUT_SECONDS` | `900` | Prazo de recebimento do upload |
| `MAX_OUTPUT_MB` | `512` | Limite de um resultado, em MiB |
| `MAX_STORED_OUTPUT_MB` | `1024` | Limite de resultados da sessão, em MiB |
| `MAX_JOBS` | `100` | Resultados por sessão |

Os limites de recursos e tempo são independentes e devem ser inteiros positivos. `PORT` aceita de 0 a 65535; zero escolhe uma porta disponível. O limite de 10 GiB não remove o teto de 20 milhões de registros. A interface consulta os limites efetivos antes do envio. O processamento continua cancelável por desconexão e não tem timeout de inatividade do socket. Esses limites configuráveis são aplicados pelo servidor HTTP; os comandos CLI não os importam automaticamente do ambiente.

Defina as variáveis no ambiente do processo. O projeto não carrega arquivos `.env` automaticamente. Exemplo no Windows PowerShell:

```powershell
$env:PORT = '3001'
npm run launch
```

Exemplo em Linux ou macOS:

```sh
PORT=3001 npm run launch
```

Não há banco de dados. Resultados HTTP ficam em diretório temporário e são removidos no encerramento normal; exporte o que precisar antes de reiniciar. O serviço não possui autenticação e foi projetado para uso local. A comparação HTTP aceita até 20 MiB tanto para o gabarito quanto para o resultado; a comparação CLI carrega os dois arrays JSON em memória. A exportação ZIP usa streaming, sem compressão, e possui limite de formato inferior a 4 GiB; JSONs individuais continuam disponíveis para exportação.

## API

| Método | Rota | Uso |
|---|---|---|
| GET | `/api/health` | Estado e limites efetivos |
| GET | `/api/example` | Arquivo de exemplo |
| POST | `/api/inspect?filename=arquivo.txt` | Pré-validar TXT enviado no corpo |
| POST | `/api/process?filename=arquivo.txt` | Processar TXT; aceita `mode` e `genericPolicy` |
| GET | `/api/jobs` | Resultados da sessão |
| GET | `/api/jobs/:id/results` | Paginação e filtros |
| GET | `/api/jobs/:id/map` | Dados do mapa |
| GET | `/api/jobs/:id/download` | Exportar JSON |
| POST | `/api/jobs/:id/compare` | Comparar com gabarito JSON |
| GET | `/api/download-all` | Exportar ZIP dos resultados |

Na consulta de resultados, `offset` começa em zero, `limit` vai de 1 a 100 (padrão 10), `type` aceita `generico`, `faccao` ou `protetiva`, e `search` pesquisa trechos de IDs ou timestamp. A rota do mapa retorna uma amostra determinística de até 750 encontros.

Erros de entrada retornam 400; recursos ausentes, 404; excesso de recursos, 413; concorrência, 429; erros internos, 500 sem caminhos ou stack traces.

## Verificações adicionais

O benchmark usa entradas temporárias e pode gerar um novo relatório em `benchmarks/` somente quando solicitado:

```powershell
npm run benchmark -- --quick
npm run benchmark
```

A auditoria completa dos arquivos 5, 6 e 7 é separada da suíte rápida. Ela exige os três arquivos originais, valida uploads e resultados HTTP e compara todos os pares por força bruta. Ao ser executada, gera um relatório em `benchmarks/` e os JSONs em `outputs/`:

```powershell
node --max-old-space-size=256 tests/large-datasets.mjs "dados/dataset5.txt" "dados/dataset6.txt" "dados/dataset7.txt"
```

Gere o build antes da auditoria. O teste é específico para os arquivos `dataset5.txt`, `dataset6.txt` e `dataset7.txt`, com 1, 8 e 12 milhões de registros respectivamente, na política `all`. Caminhos absolutos também são aceitos, portanto esses arquivos grandes podem continuar fora do projeto. A referência por força bruta possui enumeração, classificação e cálculo de distância próprios, compartilhando o parser do projeto.

A suíte `npm test` mantém expectativas fixas nos próprios testes e não depende dos relatórios ou resultados gerados pela auditoria. Ela também verifica a navegação durante rolagem, mudanças na altura da página e menu recolhido ou móvel. O menu segue a ordem das seções, marca a localização atual e atualiza o cabeçalho.

Para a entrega, execute `npm run typecheck`, `npm test` e `npm run launch -- --check`. Os comandos e o iniciador Windows foram exercitados em Windows com Node.js 24.17.0. O iniciador POSIX e os ramos Linux/macOS foram revisados no código; a execução nativa nesses dois sistemas precisa ser conferida com `--check` no sistema de destino.
