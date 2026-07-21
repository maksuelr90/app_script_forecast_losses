// ===== CONFIGURAÇÃO =====
// Cadastre em: Configurações do projeto (⚙️) > Propriedades do script
//   DS_CLIENT_ID     -> seu client_id (app-key)
//   DS_CLIENT_SECRET -> seu client_secret (app-secret)
const CONFIG = {
  CLIENT_ID: PropertiesService.getScriptProperties().getProperty('DS_CLIENT_ID'),
  CLIENT_SECRET: PropertiesService.getScriptProperties().getProperty('DS_CLIENT_SECRET'),
  SYSTEM_NAME: 'inventory_forecast_losses',
  END_USER: 'maksuel.rosa@shopee.com',
  TOKEN_URL: 'https://open-api.datasuite.shopeemobile.com/oauth/token',
  BASE_URL: 'https://open-api.datasuite.shopeemobile.com/dataservice',
  // Escopo precisa conter TODAS as APIs que o client_id vai consultar
  // (separadas por ESPAÇO - padrão OAuth2 - e não por vírgula)
  SCOPE: 'brbi_opslgc.inventory_forecast_losses_fwd ' +
         'brbi_opslgc.inventory_forecast_losses_losses ' +
         'brbi_opslgc.inventory_forecast_losses_volume ' +
         'brbi_opslgc.inventory_forecast_losses_last_update'
};

// ===== CONFIGURAÇÃO DO BIGQUERY (compartilhada entre todas as fontes) =====
const BQ_CONFIG = {
  PROJECT_ID: 'inventory-backlog',
  DATASET_ID: 'forecast_losses',
  LOCATION: 'southamerica-east1'
};

// ===== FONTES DE DADOS =====
// Cada fonte é uma API do DataSuite com sua própria tabela oficial + tabela temp no BigQuery.
// Para adicionar uma nova fonte no futuro, basta acrescentar um item aqui.
const SOURCES = [
  {
    key: 'fwd',
    apiName: 'brbi_opslgc.inventory_forecast_losses_fwd',
    version: '98jxj9f37nfdmz8g',
    tableId: 'inventory_forecast_losses_fwd',
    tempTableId: 'inventory_forecast_losses_fwd_temp'
  },
  {
    key: 'losses',
    apiName: 'brbi_opslgc.inventory_forecast_losses_losses',
    version: '6omrilsppgkoacdt',
    tableId: 'inventory_forecast_losses_losses',
    tempTableId: 'inventory_forecast_losses_losses_temp'
  },
  {
    key: 'volume',
    apiName: 'brbi_opslgc.inventory_forecast_losses_volume',
    version: 'j5e1k47fzrz2ibwo',
    tableId: 'inventory_forecast_losses_volume',
    tempTableId: 'inventory_forecast_losses_volume_temp'
  }
];

// ===== FONTE LEVE - só pra checar a última atualização (grass_datetime) =====
// Retorna apenas 1 linha, então é muito mais barata/rápida que consultar a
// fonte de referência "fwd" inteira só pra saber se há divergência.
const LAST_UPDATE_SOURCE = {
  key: 'last_update',
  apiName: 'brbi_opslgc.inventory_forecast_losses_last_update',
  version: 'qdp4uimrclkpcy8p'
};

// ===== 1. Obter access token =====
function getAccessToken_() {
  const url = `${CONFIG.TOKEN_URL}?client_id=${encodeURIComponent(CONFIG.CLIENT_ID)}` +
    `&client_secret=${encodeURIComponent(CONFIG.CLIENT_SECRET)}` +
    `&scope=${encodeURIComponent(CONFIG.SCOPE)}` +
    `&grant_type=client_credentials`;

  const options = { method: 'post', muteHttpExceptions: true };
  const response = UrlFetchApp.fetch(url, options);
  const code = response.getResponseCode();
  const body = response.getContentText();

  Logger.log('Token status: ' + code);

  if (code !== 200) {
    throw new Error(`Erro ao obter token: ${code} - ${body}`);
  }

  const json = JSON.parse(body);
  return json.access_token;
}

// ===== 2. Disparar a query de uma fonte específica (retorna jobId) =====
function triggerQuery_(token, source) {
  const url = `${CONFIG.BASE_URL}/${source.apiName}/${source.version}`;

  const payload = {
    olapPayload: {
      expressions: []
    }
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Authorization': 'Bearer ' + token,
      'X-End-User': CONFIG.END_USER,
      'X-System-Name': CONFIG.SYSTEM_NAME,
      "dataservice-sdk-type": "appscript"
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(url, options);
  const code = response.getResponseCode();
  const body = response.getContentText();

  Logger.log(`[${source.key}] Trigger status: ${code}`);

  if (code !== 200) {
    throw new Error(`[${source.key}] Erro ao disparar query: ${code} - ${body}`);
  }

  const json = JSON.parse(body);
  return json.jobId;
}

// ===== Faz o polling do status do job até finalizar =====
function pollJobAteFinalizar_(token, jobId, maxTentativas = 10, esperaMs = 2000) {
  const metaUrl = `${CONFIG.BASE_URL}/result/${jobId}`;

  const options = {
    method: 'get',
    headers: {
      'Authorization': 'Bearer ' + token,
      'X-End-User': CONFIG.END_USER,
      'X-System-Name': CONFIG.SYSTEM_NAME,
      "dataservice-sdk-type": "appscript"
    },
    muteHttpExceptions: true
  };

  let meta;
  for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
    const response = UrlFetchApp.fetch(metaUrl, options);
    const code = response.getResponseCode();
    const body = response.getContentText();

    if (code === 200) {
      meta = JSON.parse(body);
      Logger.log(`Tentativa ${tentativa} - job status: ${meta.status}`);
      if (meta.status === 'FINISH') return meta;
    }

    Utilities.sleep(esperaMs);
  }

  throw new Error('Job não finalizou a tempo.');
}

// ===== Busca um único shard (função reutilizável) =====
function buscarShard_(fetchUrlTemplate, shard, token) {
  const options = {
    method: 'get',
    headers: {
      'Authorization': 'Bearer ' + token,
      'X-End-User': CONFIG.END_USER,
      'X-System-Name': CONFIG.SYSTEM_NAME,
      "dataservice-sdk-type": "appscript"
    },
    muteHttpExceptions: true
  };

  const shardUrl = fetchUrlTemplate.replace('{shard}', shard);
  const response = UrlFetchApp.fetch(shardUrl, options);
  const code = response.getResponseCode();
  const body = response.getContentText();

  if (code !== 200) {
    throw new Error(`Erro ao buscar shard ${shard}: ${code} - ${body}`);
  }

  return JSON.parse(body);
}

// ===== Extrai o valor de grass_datetime da primeira linha de um shard =====
function extrairGrassDatetime_(shardJson) {
  if (!shardJson.rows || shardJson.rows.length === 0) return null;
  const primeiraLinha = shardJson.rows[0];
  return primeiraLinha.values ? primeiraLinha.values['grass_datetime'] : null;
}

// ===== Consulta o MAX(grass_datetime) já salvo em uma tabela OFICIAL do BigQuery =====
// Retorna null se a tabela ainda não existir (primeira execução) ou estiver vazia.
function obterUltimoGrassDatetimeBigQuery_(tableId) {
  const query = `SELECT MAX(grass_datetime) AS max_dt ` +
    `FROM \`${BQ_CONFIG.PROJECT_ID}.${BQ_CONFIG.DATASET_ID}.${tableId}\``;

  try {
    const response = BigQuery.Jobs.query(
      { query: query, useLegacySql: false, location: BQ_CONFIG.LOCATION },
      BQ_CONFIG.PROJECT_ID
    );

    if (!response.rows || response.rows.length === 0) return null;
    const valor = response.rows[0].f[0].v;
    return valor || null;
  } catch (e) {
    Logger.log(`[${tableId}] Não foi possível ler grass_datetime (provavelmente tabela ainda não existe): ${e.message}`);
    return null;
  }
}

// ===== Normaliza um valor de grass_datetime (string de data OU epoch numérico) para ms desde epoch =====
// Permite comparar valores vindos de fontes com formatos diferentes (DataSuite retorna
// string tipo "2026-07-17 08:54:16.136"; BigQuery retorna epoch em segundos, às vezes em
// notação científica tipo "1.784278456136E9").
function normalizarGrassDatetime_(valor) {
  if (valor === null || valor === undefined || valor === '') return null;

  const str = String(valor).trim();

  // Tenta primeiro como número (cobre epoch simples E notação científica)
  const numero = Number(str);
  if (!isNaN(numero) && isFinite(numero)) {
    return Math.round(numero * 1000);
  }

  // Caso contrário, assume string de data/hora (ex: "2026-07-17 08:54:16.136") -> assume UTC
  const temTimezone = /[zZ]$/.test(str) || /[+-]\d{2}:\d{2}$/.test(str);
  const isoCompativel = str.replace(' ', 'T') + (temTimezone ? '' : 'Z');
  const timestamp = Date.parse(isoCompativel);

  return isNaN(timestamp) ? null : timestamp;
}

// ===== Converte o tipo do DataSuite para o tipo do BigQuery =====
function mapTipoParaBigQuery_(tipoDataSuite) {
  const tipo = tipoDataSuite.toLowerCase();
  if (tipo.startsWith('varchar')) return 'STRING';
  if (tipo === 'bigint' || tipo === 'int' || tipo === 'integer') return 'INT64';
  if (tipo === 'date') return 'DATE';
  if (tipo.startsWith('timestamp')) return 'TIMESTAMP';
  if (tipo === 'double' || tipo === 'float') return 'FLOAT64';
  if (tipo === 'boolean') return 'BOOL';
  Logger.log(`Aviso: tipo desconhecido "${tipoDataSuite}", usando STRING como fallback.`);
  return 'STRING';
}

// ===== Garante que a tabela existe no BigQuery, criando-a se necessário =====
function ensureTableExists_(resultSchema, tableId) {
  const schemaFields = resultSchema.map(col => ({
    name: col.columnName,
    type: mapTipoParaBigQuery_(col.type),
    mode: 'NULLABLE'
  }));

  try {
    BigQuery.Tables.get(BQ_CONFIG.PROJECT_ID, BQ_CONFIG.DATASET_ID, tableId);
    Logger.log(`Tabela ${tableId} já existe no BigQuery. Prosseguindo com a inserção.`);
  } catch (e) {
    Logger.log(`Tabela ${tableId} não encontrada. Criando no BigQuery...`);

    const table = {
      tableReference: {
        projectId: BQ_CONFIG.PROJECT_ID,
        datasetId: BQ_CONFIG.DATASET_ID,
        tableId: tableId
      },
      schema: {
        fields: schemaFields
      }
    };

    BigQuery.Tables.insert(table, BQ_CONFIG.PROJECT_ID, BQ_CONFIG.DATASET_ID);
    Logger.log(`Tabela ${tableId} criada com sucesso.`);
  }
}

// ===== Insere linhas no BigQuery via LOAD JOB =====
// Streaming insert (tabledata.insertAll) NÃO é permitido na camada gratuita do BigQuery.
// Load jobs são gratuitos mesmo no sandbox - por isso esse método.
function insertRowsToBigQuery_(rows, resultSchema, tableId) {
  if (!rows || rows.length === 0) return 0;

  const ndjson = rows.map(row => JSON.stringify(row.values)).join('\n');
  const blob = Utilities.newBlob(ndjson, 'application/json');

  const jobResource = {
    configuration: {
      load: {
        destinationTable: {
          projectId: BQ_CONFIG.PROJECT_ID,
          datasetId: BQ_CONFIG.DATASET_ID,
          tableId: tableId
        },
        sourceFormat: 'NEWLINE_DELIMITED_JSON',
        writeDisposition: 'WRITE_APPEND', // acrescenta às linhas já existentes na tabela TEMP
        ignoreUnknownValues: false,
        maxBadRecords: 0
      }
    },
    jobReference: {
      projectId: BQ_CONFIG.PROJECT_ID,
      location: BQ_CONFIG.LOCATION
    }
  };

  const insertedJob = BigQuery.Jobs.insert(jobResource, BQ_CONFIG.PROJECT_ID, blob);
  const jobId = insertedJob.jobReference.jobId;
  const jobLocation = insertedJob.jobReference.location || BQ_CONFIG.LOCATION;

  const jobFinalizado = aguardarJobBigQuery_(jobId, jobLocation);

  if (jobFinalizado.status.errorResult) {
    throw new Error('Erro no load job: ' + JSON.stringify(jobFinalizado.status.errorResult));
  }

  return rows.length;
}

// ===== Aguarda um job do BigQuery terminar (load ou query) =====
function aguardarJobBigQuery_(jobId, location, maxTentativas = 15, esperaMs = 1000) {
  for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
    const job = BigQuery.Jobs.get(BQ_CONFIG.PROJECT_ID, jobId, { location: location });
    if (job.status.state === 'DONE') {
      return job;
    }
    Utilities.sleep(esperaMs);
  }
  throw new Error(`Job ${jobId} não finalizou a tempo.`);
}

// ===== Apaga uma tabela do BigQuery, se ela existir (não gera erro se não existir) =====
function apagarTabelaSeExistir_(tableId) {
  try {
    BigQuery.Tables.remove(BQ_CONFIG.PROJECT_ID, BQ_CONFIG.DATASET_ID, tableId);
    Logger.log(`Tabela ${tableId} removida.`);
  } catch (e) {
    Logger.log(`Tabela ${tableId} não existia (ok, ignorando): ${e.message}`);
  }
}

// ===== Troca a tabela TEMP pela tabela OFICIAL (zero downtime) =====
function trocarTabelaTempPelaOficial_(tableIdOficial, tableIdTemp) {
  Logger.log(`Iniciando troca: ${tableIdTemp} -> ${tableIdOficial}...`);

  apagarTabelaSeExistir_(tableIdOficial);

  const query = `ALTER TABLE \`${BQ_CONFIG.PROJECT_ID}.${BQ_CONFIG.DATASET_ID}.${tableIdTemp}\` ` +
    `RENAME TO ${tableIdOficial}`;

  const jobResource = {
    configuration: {
      query: {
        query: query,
        useLegacySql: false
      }
    },
    jobReference: {
      projectId: BQ_CONFIG.PROJECT_ID,
      location: BQ_CONFIG.LOCATION
    }
  };

  const insertedJob = BigQuery.Jobs.insert(jobResource, BQ_CONFIG.PROJECT_ID);
  const jobId = insertedJob.jobReference.jobId;
  const jobLocation = insertedJob.jobReference.location || BQ_CONFIG.LOCATION;

  const jobFinalizado = aguardarJobBigQuery_(jobId, jobLocation);

  if (jobFinalizado.status.errorResult) {
    throw new Error(`Erro ao renomear ${tableIdTemp} para ${tableIdOficial}: ` + JSON.stringify(jobFinalizado.status.errorResult));
  }

  Logger.log(`✅ Troca concluída: ${tableIdOficial} agora contém os dados mais recentes.`);
}

// ===================================================================
// ===== SINCRONIZAÇÃO MULTI-FONTE, COM CHECAGEM DE FRESHNESS E RETOMADA =====
// ===================================================================
// Processa cada fonte em SOURCES, uma de cada vez. Para cada fonte:
//   1. Dispara a query no DataSuite.
//   2. Busca o shard 0 e compara o grass_datetime com o já salvo na tabela oficial.
//   3. Se igual -> pula essa fonte (nenhuma tabela é tocada).
//   4. Se diferente -> carrega todos os shards na tabela TEMP e troca pela oficial no final.
// Tudo isso respeitando o limite de 6 minutos do Apps Script: se o tempo acabar
// no meio do processo (mesmo no meio de uma fonte específica), o progresso é salvo
// e um trigger automático continua exatamente de onde parou.
//
// ===== RETRY AUTOMÁTICO (INDEFINIDO) =====
// Se qualquer etapa lançar um erro (rede instável, tabela temp sumiu, job travou
// etc.), o processo NÃO trava e NUNCA desiste: registra a tentativa e reagenda
// automaticamente uma nova, a partir do MESMO ponto onde parou (reaproveita o
// estado salvo em PropertiesService), com espera crescente entre tentativas.
// STATUS nunca vira 'ERROR' permanente - só volta a 'DONE' quando de fato
// conseguir terminar. Enquanto isso, o usuário recebe um e-mail periódico
// (não a cada tentativa) só pra avisar que o problema persiste.

const SYNC_PROPS_KEYS = {
  CURRENT_SOURCE_INDEX: 'SYNC_CURRENT_SOURCE_INDEX',
  CHECAGEM_FEITA: 'SYNC_CHECAGEM_FEITA',
  FORCAR: 'SYNC_FORCAR',
  JOB_ID: 'SYNC_JOB_ID',
  FETCH_URL_TEMPLATE: 'SYNC_FETCH_URL_TEMPLATE',
  MAX_SHARD: 'SYNC_MAX_SHARD',
  NEXT_SHARD: 'SYNC_NEXT_SHARD',
  SCHEMA: 'SYNC_SCHEMA',
  STATUS: 'SYNC_STATUS',
  TOTAL_INSERIDAS: 'SYNC_TOTAL_INSERIDAS',
  RETRY_COUNT: 'SYNC_RETRY_COUNT',
  GRASS_DETECTADO: 'SYNC_GRASS_DETECTADO',
  SHARDS_PROCESSADOS_TOTAL: 'SYNC_SHARDS_PROCESSADOS_TOTAL',
  SHARDS_CONHECIDOS_TOTAL: 'SYNC_SHARDS_CONHECIDOS_TOTAL',
  ULTIMO_LOG: 'SYNC_ULTIMO_LOG'
};

const SYNC_TRIGGER_HANDLER = 'continueSync_';
const MAX_EXECUTION_MS = 5 * 60 * 1000 + 20 * 1000; // 5min20s - margem antes do limite de 6min
const NOTIFICAR_A_CADA_TENTATIVAS = 5; // manda e-mail a cada 5 falhas consecutivas, sem parar de tentar

// ===== Registra uma mensagem no Logger (como sempre) E guarda como o
// "último log" da sincronização no PropertiesService, pra o front-end poder
// exibir em tempo real que o processo está avançando (evita parecer travado
// durante etapas demoradas, como aguardar um shard ou um load job). =====
function registrarLogSync_(mensagem) {
  Logger.log(mensagem);
  try {
    PropertiesService.getScriptProperties().setProperty(SYNC_PROPS_KEYS.ULTIMO_LOG, String(mensagem).slice(0, 300));
  } catch (e) {
    // Não deixa uma falha ao salvar o log derrubar o processo de sincronização.
  }
}

// ===== Consulta o grass_datetime mais recente usando a API leve de checagem =====
// (brbi_opslgc.inventory_forecast_losses_last_update - retorna só 1 linha).
// Faz retries silenciosos em caso de erro (rede instável, job travado etc.) -
// nunca propaga a exceção pro chamador. Se todas as tentativas falharem,
// retorna null (o chamador entende isso como "não deu pra confirmar agora,
// tentaremos de novo na próxima checagem" - sem forçar uma sincronização
// desnecessária nem exibir erro pro usuário).
function consultarUltimaAtualizacaoDataSuite_() {
  const maxTentativas = 3;

  for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
    try {
      const token = getAccessToken_();
      const jobId = triggerQuery_(token, LAST_UPDATE_SOURCE);
      const meta = pollJobAteFinalizar_(token, jobId);
      const fetchUrlTemplateCorrigido = meta.fetchUrlTemplate.replace(
        'open-api.datasuite.shopee.io',
        'open-api.datasuite.shopeemobile.com'
      );
      const shard0Json = buscarShard_(fetchUrlTemplateCorrigido, 0, token);
      return extrairGrassDatetime_(shard0Json);
    } catch (erro) {
      Logger.log(`[last_update] Tentativa ${tentativa}/${maxTentativas} falhou (retry silencioso): ${erro.message}`);
      if (tentativa < maxTentativas) {
        Utilities.sleep(2000 * tentativa); // pequeno backoff crescente entre tentativas
      }
    }
  }

  Logger.log('[last_update] Não foi possível confirmar a última atualização após todas as tentativas silenciosas - checagem adiada.');
  return null;
}

// ===== Checa se há necessidade de atualização (via API leve de last_update) =====
// Retorna:
//   - false: nada mudou (ou não foi possível confirmar agora) - não precisa sincronizar
//   - true: há divergência (ou "forcar" está ligado)
function executarChecagemFreshness_() {
  const props = PropertiesService.getScriptProperties();
  const forcar = props.getProperty(SYNC_PROPS_KEYS.FORCAR) === '1';

  if (forcar) {
    Logger.log('Sincronização forçada - pulando checagem de freshness.');
    props.setProperty(SYNC_PROPS_KEYS.CHECAGEM_FEITA, '1');
    return true;
  }

  registrarLogSync_('Checando necessidade de atualização (API leve last_update)...');

  const grassAtual = consultarUltimaAtualizacaoDataSuite_();
  const epochAtual = normalizarGrassDatetime_(grassAtual);

  if (epochAtual === null) {
    // Falha silenciosa (já tentou algumas vezes) ou API sem dado ainda -
    // não força sincronização; próxima checagem (manual ou periódica) tenta de novo.
    Logger.log('Não foi possível confirmar o grass_datetime mais recente agora - nenhuma sincronização será iniciada.');
    return false;
  }

  const grassBQ = obterUltimoGrassDatetimeBigQuery_(SOURCES[0].tableId);
  const epochBQ = normalizarGrassDatetime_(grassBQ);

  Logger.log(`grass_datetime DataSuite (API leve, bruto): ${grassAtual}`);
  Logger.log(`grass_datetime BigQuery (bruto): ${grassBQ}`);
  Logger.log(`grass_datetime normalizado - DataSuite: ${epochAtual} | BigQuery: ${epochBQ}`);

  if (epochAtual === epochBQ) {
    return false;
  }

  Logger.log('Divergência detectada - todas as fontes serão sincronizadas.');
  registrarLogSync_('Nova atualização detectada - iniciando sincronização das fontes...');
  props.setProperty(SYNC_PROPS_KEYS.CHECAGEM_FEITA, '1');
  // Já sabemos a data/hora mais recente detectada desde este momento - guarda
  // pra front-end exibir sem precisar esperar a sincronização terminar e o
  // dado ser regravado no BigQuery.
  props.setProperty(SYNC_PROPS_KEYS.GRASS_DETECTADO, String(grassAtual));

  return true;
}

// ===== Inicia uma nova sincronização de TODAS as fontes =====
// Passe forcar=true para ignorar a checagem de grass_datetime e sincronizar sempre.
//
// FLUXO: 1) trava de concorrência, 2) checagem de freshness SÍNCRONA (rápida -
// 1 chamada à API + comparação), 3) só se houver divergência real, agenda o
// trigger que faz o trabalho pesado (carregar todos os shards) via servidor.
// Ou seja: você sempre sabe rapidinho se havia ou não necessidade de
// atualizar, e o processamento pesado nunca fica preso à conexão de quem
// chamou essa função.
//
// TRAVA DE CONCORRÊNCIA (nível DataBase.gs): protege QUALQUER forma de chamada -
// pelo dashboard (Code.gs), rodando manualmente pelo editor do Apps Script, ou
// por um trigger futuro. Se já houver uma sincronização em andamento, esta
// função se recusa a iniciar outra por cima (o que apagaria o progresso da
// primeira via limparEstadoSync_ e poderia recriar o incidente de tabelas
// deletadas/expiradas em operação, causado por duas sincronizações concorrentes
// mexendo nas mesmas tabelas temp).
function startSync(forcar) {
  const props = PropertiesService.getScriptProperties();

  // Caminho rápido: já sabemos que tem uma em andamento, nem precisa do lock.
  if (props.getProperty(SYNC_PROPS_KEYS.STATUS) === 'IN_PROGRESS') {
    Logger.log('⚠️ Já existe uma sincronização em andamento. startSync() ignorado para não sobrepor o progresso.');
    return;
  }

  const lock = LockService.getScriptLock();
  let obteveLock = false;

  try {
    obteveLock = lock.tryLock(10000);

    if (!obteveLock) {
      Logger.log('⚠️ Não foi possível obter o lock (outro processo deve estar iniciando uma sincronização agora). startSync() ignorado.');
      return;
    }

    // Double-check dentro do lock: outra execução pode ter iniciado enquanto
    // esperávamos o lock.
    if (props.getProperty(SYNC_PROPS_KEYS.STATUS) === 'IN_PROGRESS') {
      Logger.log('⚠️ Sincronização iniciada por outro processo enquanto esperávamos o lock. startSync() ignorado.');
      return;
    }

    limparEstadoSync_();
    removerTriggerSync_();

    props.setProperty(SYNC_PROPS_KEYS.CURRENT_SOURCE_INDEX, '0');
    props.setProperty(SYNC_PROPS_KEYS.CHECAGEM_FEITA, '0');
    props.setProperty(SYNC_PROPS_KEYS.FORCAR, forcar ? '1' : '0');
    props.setProperty(SYNC_PROPS_KEYS.STATUS, 'IN_PROGRESS');
    props.setProperty(SYNC_PROPS_KEYS.RETRY_COUNT, '0');

    let precisaAtualizar;
    try {
      precisaAtualizar = executarChecagemFreshness_();
    } catch (erro) {
      Logger.log('❌ Erro ao checar necessidade de atualização: ' + erro.message);
      // Mesmo tratamento das demais falhas: NÃO trava em ERROR, agenda uma
      // nova tentativa automaticamente (mantém STATUS = 'IN_PROGRESS').
      tratarErroSync_(erro);
      return;
    }

    if (!precisaAtualizar) {
      Logger.log('✅ Nenhuma atualização necessária. Nada foi agendado.');
      props.setProperty(SYNC_PROPS_KEYS.STATUS, 'DONE');
      return;
    }

    Logger.log(`Divergência confirmada - agendando processamento das ${SOURCES.length} fonte(s) via trigger.`);

    // A partir daqui, TODO o trabalho pesado (shards restantes + demais
    // fontes) roda via trigger no servidor - sem depender do chamador
    // continuar conectado.
    ScriptApp.newTrigger(SYNC_TRIGGER_HANDLER)
      .timeBased()
      .after(1000)
      .create();
  } finally {
    if (obteveLock) lock.releaseLock();
  }
}

// ===== Utilitário: destrava uma sincronização "presa" manualmente =====
// Use APENAS se tiver certeza de que não existe nenhuma execução realmente
// rodando (ex: STATUS ficou em 'IN_PROGRESS' por causa de uma queda inesperada
// e não há trigger nem execução ativa no painel "Execuções" do Apps Script).
// Depois de rodar isso, o próximo startSync() começa limpo.
function resetarSincronizacaoTravada() {
  removerTriggerSync_();
  limparEstadoSync_();
  Logger.log('✅ Estado de sincronização resetado manualmente. Pode iniciar uma nova sincronização normalmente.');
}

// ===== Força a sincronização de TODAS as fontes, ignorando a checagem de grass_datetime =====
// Use esta função quando quiser rodar pelo botão "Executar" do editor (que não permite
// passar parâmetros) - ela simplesmente chama startSync(true) por baixo.
function forcarSync() {
  Logger.log('Sincronização FORÇADA solicitada - a checagem de grass_datetime será ignorada.');
  startSync(true);
}

// ===== Ponto de entrada chamado manualmente ou pelo trigger de continuação/retry =====
// Envolve continueSyncInterno_ num try/catch: se der erro, aciona o retry em vez
// de deixar a exceção subir e a sincronização morrer no meio do caminho.
function continueSync_() {
  const props = PropertiesService.getScriptProperties();

  try {
    continueSyncInterno_();
    // Chegou até aqui sem lançar erro -> zera o contador de tentativas,
    // porque tentativas anteriores não devem "contar" contra um erro futuro
    // não relacionado.
    props.setProperty(SYNC_PROPS_KEYS.RETRY_COUNT, '0');
  } catch (erro) {
    tratarErroSync_(erro);
  }
}

// ===== Trata um erro ocorrido durante a sincronização =====
// Tenta indefinidamente - NUNCA desiste e trava em ERROR permanente. A cada
// falha, reagenda automaticamente com um tempo de espera crescente (evita
// martelar o servidor se o erro for persistente), e avisa por e-mail de
// tempos em tempos enquanto o problema continuar, sem parar de tentar.
function tratarErroSync_(erro) {
  const props = PropertiesService.getScriptProperties();
  const tentativaAtual = parseInt(props.getProperty(SYNC_PROPS_KEYS.RETRY_COUNT) || '0', 10) + 1;
  props.setProperty(SYNC_PROPS_KEYS.RETRY_COUNT, String(tentativaAtual));

  Logger.log(`❌ Erro na sincronização (tentativa ${tentativaAtual}): ${erro.message}`);
  registrarLogSync_(`⚠️ Falha temporária (tentativa ${tentativaAtual}) - tentando novamente automaticamente...`);

  // Notifica por e-mail a cada N tentativas consecutivas (não a cada uma,
  // pra não inundar a caixa de entrada) - só um aviso de "ainda não
  // resolveu", o processo continua tentando sozinho.
  if (tentativaAtual % NOTIFICAR_A_CADA_TENTATIVAS === 0) {
    notificarErroSync_(erro, tentativaAtual);
  }

  Logger.log('🔁 Reagendando nova tentativa a partir do ponto onde parou...');
  // Mantém STATUS = 'IN_PROGRESS' (nunca vira ERROR) - o front-end continua
  // mostrando "atualizando", e o processo retoma do mesmo source/shard salvo.
  agendarContinuacaoComBackoff_(tentativaAtual);
}

// ===== Agenda a próxima tentativa com espera crescente (backoff) =====
// 1ª tentativa: 1 min · 2ª: 2 min · 3ª: 5 min · a partir da 4ª: 10 min (fixo).
// Isso evita ficar tentando de 1 em 1 minuto pra sempre se o erro for
// persistente (ex: API fora do ar por um tempo), sem desistir.
function agendarContinuacaoComBackoff_(tentativa) {
  const escalonamento = [60, 120, 300, 600]; // segundos
  const delaySegundos = escalonamento[Math.min(tentativa - 1, escalonamento.length - 1)];

  removerTriggerSync_();
  ScriptApp.newTrigger(SYNC_TRIGGER_HANDLER)
    .timeBased()
    .after(delaySegundos * 1000)
    .create();

  Logger.log(`Próxima tentativa agendada para daqui a ${delaySegundos}s.`);
}

// ===== Notifica que o erro persiste (processo continua tentando sozinho) =====
function notificarErroSync_(erro, tentativas) {
  const mensagem = `A sincronização do Loss SOC está falhando repetidamente ` +
    `(${tentativas} tentativas até agora) - mas o processo continua tentando ` +
    `automaticamente, sem intervenção necessária. Se persistir por muito tempo, ` +
    `vale investigar.\n\nÚltimo erro: ${erro.message}`;
  Logger.log(mensagem);

  try {
    MailApp.sendEmail(CONFIG.END_USER, '⚠️ Sincronização com falhas repetidas - Loss SOC Dashboard', mensagem);
  } catch (erroEmail) {
    Logger.log('Não foi possível enviar e-mail de notificação: ' + erroEmail.message);
  }
}

// ===== Continua a sincronização de onde parou (fonte + shard) =====
// Lógica original - chamada apenas pelo wrapper continueSync_ (que trata os erros).
function continueSyncInterno_() {
  const props = PropertiesService.getScriptProperties();

  if (props.getProperty(SYNC_PROPS_KEYS.STATUS) !== 'IN_PROGRESS') {
    Logger.log('Nenhuma sincronização em andamento. Nada a fazer.');
    return;
  }

  const inicioExecucao = Date.now();
  const forcar = props.getProperty(SYNC_PROPS_KEYS.FORCAR) === '1';

  while (true) {
    if (Date.now() - inicioExecucao > MAX_EXECUTION_MS) {
      agendarContinuacaoSync_();
      Logger.log('Tempo de execução próximo do limite. Pausando (continuação agendada).');
      return;
    }

    // ===== FASE 0: Checagem única de necessidade de atualização =====
    // Normalmente já foi feita de forma síncrona dentro de startSync(), antes
    // do trigger ser agendado (então CHECAGEM_FEITA já vem '1' aqui). Esse
    // bloco é uma salvaguarda para o caso raro de o trigger disparar antes
    // dessa flag estar setada.
    if (props.getProperty(SYNC_PROPS_KEYS.CHECAGEM_FEITA) !== '1') {
      const precisaAtualizar = executarChecagemFreshness_();

      if (!precisaAtualizar) {
        Logger.log('✅ Nenhuma atualização necessária. Nenhuma fonte será sincronizada.');
        props.setProperty(SYNC_PROPS_KEYS.STATUS, 'DONE');
        removerTriggerSync_();
        return;
      }

      continue; // volta ao topo do while, checa tempo, cai no processamento normal da fonte 0
    }

    const sourceIndex = parseInt(props.getProperty(SYNC_PROPS_KEYS.CURRENT_SOURCE_INDEX), 10);

    if (sourceIndex >= SOURCES.length) {
      props.setProperty(SYNC_PROPS_KEYS.STATUS, 'DONE');
      removerTriggerSync_();
      Logger.log('✅ Todas as fontes foram processadas. Sincronização concluída.');
      registrarLogSync_('✅ Sincronização concluída - todas as fontes atualizadas.');
      return;
    }

    const source = SOURCES[sourceIndex];
    let jobId = props.getProperty(SYNC_PROPS_KEYS.JOB_ID);

    let fetchUrlTemplate, maxShard, nextShard, resultSchema, totalInseridas;

    if (!jobId) {
      // ===== Início do processamento desta fonte (sem checagem individual - já decidido na Fase 0) =====
      Logger.log(`--- Iniciando fonte "${source.key}" (${source.apiName}) ---`);
      registrarLogSync_(`Iniciando fonte "${source.key}"...`);

      const token = getAccessToken_();
      const novoJobId = triggerQuery_(token, source);
      Logger.log(`[${source.key}] Job disparado: ${novoJobId}`);
      registrarLogSync_(`[${source.key}] Consulta disparada, aguardando processamento...`);

      const meta = pollJobAteFinalizar_(token, novoJobId);
      const fetchUrlTemplateCorrigido = meta.fetchUrlTemplate.replace(
        'open-api.datasuite.shopee.io',
        'open-api.datasuite.shopeemobile.com'
      );

      const shard0Json = buscarShard_(fetchUrlTemplateCorrigido, 0, token);
      const schema = shard0Json.resultSchema || null;

      apagarTabelaSeExistir_(source.tempTableId);
      ensureTableExists_(schema, source.tempTableId);

      let inseridasShard0 = 0;
      if (shard0Json.rows && shard0Json.rows.length > 0) {
        inseridasShard0 = insertRowsToBigQuery_(shard0Json.rows, schema, source.tempTableId);
        Logger.log(`[${source.key}] Shard 0 - ${inseridasShard0} linhas gravadas na tabela temp.`);
        registrarLogSync_(`[${source.key}] Shard 0 gravado (${inseridasShard0} linhas) - shard 1 de ${meta.maxShard + 1}`);
      }

      props.setProperty(SYNC_PROPS_KEYS.JOB_ID, novoJobId);
      props.setProperty(SYNC_PROPS_KEYS.FETCH_URL_TEMPLATE, fetchUrlTemplateCorrigido);
      props.setProperty(SYNC_PROPS_KEYS.MAX_SHARD, String(meta.maxShard));
      props.setProperty(SYNC_PROPS_KEYS.NEXT_SHARD, '1');
      props.setProperty(SYNC_PROPS_KEYS.SCHEMA, JSON.stringify(schema));
      props.setProperty(SYNC_PROPS_KEYS.TOTAL_INSERIDAS, String(inseridasShard0));

      // Progresso global (todas as fontes): agora sabemos quantos shards essa
      // fonte tem no total (maxShard+1) - soma ao total conhecido - e o shard
      // 0 dela já foi processado - soma ao total processado.
      incrementarProgressoShards_(meta.maxShard + 1, 1);

      fetchUrlTemplate = fetchUrlTemplateCorrigido;
      maxShard = meta.maxShard;
      nextShard = 1;
      resultSchema = schema;
      totalInseridas = inseridasShard0;
    } else {
      // ===== Continuando uma fonte já em andamento (retomada) =====
      fetchUrlTemplate = props.getProperty(SYNC_PROPS_KEYS.FETCH_URL_TEMPLATE);
      maxShard = parseInt(props.getProperty(SYNC_PROPS_KEYS.MAX_SHARD), 10);
      nextShard = parseInt(props.getProperty(SYNC_PROPS_KEYS.NEXT_SHARD), 10);
      resultSchema = JSON.parse(props.getProperty(SYNC_PROPS_KEYS.SCHEMA));
      totalInseridas = parseInt(props.getProperty(SYNC_PROPS_KEYS.TOTAL_INSERIDAS), 10);

      // Se a tabela temp sumiu no meio do caminho (ex: execução interrompida
      // de forma anômala), recria antes de continuar - evita o erro
      // "No schema specified on job or table" ao tentar inserir num destino
      // que não existe mais.
      ensureTableExists_(resultSchema, source.tempTableId);

      Logger.log(`[${source.key}] Retomando a partir do shard ${nextShard} (de 0 a ${maxShard})`);
      registrarLogSync_(`[${source.key}] Retomando do shard ${nextShard} de ${maxShard + 1}...`);
    }

    // ===== Processa os shards restantes desta fonte =====
    const token = getAccessToken_(); // token novo, seguro reobter a cada leva

    while (nextShard <= maxShard) {
      if (Date.now() - inicioExecucao > MAX_EXECUTION_MS) {
        props.setProperty(SYNC_PROPS_KEYS.NEXT_SHARD, String(nextShard));
        props.setProperty(SYNC_PROPS_KEYS.TOTAL_INSERIDAS, String(totalInseridas));
        agendarContinuacaoSync_();
        Logger.log(`[${source.key}] Pausando no shard ${nextShard}/${maxShard}. Continuação agendada.`);
        registrarLogSync_(`[${source.key}] Pausa técnica no shard ${nextShard} de ${maxShard + 1} - continuando em instantes...`);
        return;
      }

      const shardJson = buscarShard_(fetchUrlTemplate, nextShard, token);

      if (shardJson.rows && shardJson.rows.length > 0) {
        const inseridas = insertRowsToBigQuery_(shardJson.rows, resultSchema, source.tempTableId);
        totalInseridas += inseridas;
        Logger.log(`[${source.key}] Shard ${nextShard} - ${inseridas} linhas (total: ${totalInseridas})`);
      }

      registrarLogSync_(`[${source.key}] Shard ${nextShard} de ${maxShard + 1} gravado (total da fonte: ${totalInseridas} linhas)`);

      nextShard++;
      props.setProperty(SYNC_PROPS_KEYS.NEXT_SHARD, String(nextShard));
      props.setProperty(SYNC_PROPS_KEYS.TOTAL_INSERIDAS, String(totalInseridas));
      incrementarProgressoShards_(0, 1); // mais 1 shard processado (progresso global)
    }

    // ===== Fonte concluída: troca temp -> oficial e avança para a próxima =====
    trocarTabelaTempPelaOficial_(source.tableId, source.tempTableId);
    Logger.log(`[${source.key}] ✅ Concluído. Total de linhas: ${totalInseridas}.`);
    registrarLogSync_(`[${source.key}] ✅ Concluído (${totalInseridas} linhas gravadas)`);

    avancarParaProximaFonte_(props);
  }
}

// ===== Avança o índice de fonte e limpa o estado específico da fonte atual =====
function avancarParaProximaFonte_(props) {
  const idx = parseInt(props.getProperty(SYNC_PROPS_KEYS.CURRENT_SOURCE_INDEX), 10);
  props.setProperty(SYNC_PROPS_KEYS.CURRENT_SOURCE_INDEX, String(idx + 1));

  props.deleteProperty(SYNC_PROPS_KEYS.JOB_ID);
  props.deleteProperty(SYNC_PROPS_KEYS.FETCH_URL_TEMPLATE);
  props.deleteProperty(SYNC_PROPS_KEYS.MAX_SHARD);
  props.deleteProperty(SYNC_PROPS_KEYS.NEXT_SHARD);
  props.deleteProperty(SYNC_PROPS_KEYS.SCHEMA);
  props.deleteProperty(SYNC_PROPS_KEYS.TOTAL_INSERIDAS);
}

// ===== Agenda a próxima continuação automaticamente (daqui a 1 minuto) =====
function agendarContinuacaoSync_() {
  removerTriggerSync_();
  ScriptApp.newTrigger(SYNC_TRIGGER_HANDLER)
    .timeBased()
    .after(60 * 1000)
    .create();
}

// ===== Remove qualquer trigger de continuação pendente =====
function removerTriggerSync_() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(trigger => {
    if (trigger.getHandlerFunction() === SYNC_TRIGGER_HANDLER) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

// ===== Limpa o estado salvo (usado ao iniciar uma sincronização nova) =====
function limparEstadoSync_() {
  const props = PropertiesService.getScriptProperties();
  Object.values(SYNC_PROPS_KEYS).forEach(key => props.deleteProperty(key));
}

// ===== Incrementa (de forma atômica o quanto der) os contadores globais de =====
// ===== progresso: shards conhecidos até agora e shards já processados. =====
// conhecidosNovos: quantos shards a MAIS passaram a ser conhecidos agora
// (normalmente maxShard+1 de uma fonte que acabou de iniciar; 0 se nenhum).
// processadosNovos: quantos shards a MAIS foram processados agora (1 na
// maioria das chamadas - um shard de cada vez).
function incrementarProgressoShards_(conhecidosNovos, processadosNovos) {
  const props = PropertiesService.getScriptProperties();

  if (conhecidosNovos) {
    const conhecidosAtual = parseInt(props.getProperty(SYNC_PROPS_KEYS.SHARDS_CONHECIDOS_TOTAL) || '0', 10);
    props.setProperty(SYNC_PROPS_KEYS.SHARDS_CONHECIDOS_TOTAL, String(conhecidosAtual + conhecidosNovos));
  }

  if (processadosNovos) {
    const processadosAtual = parseInt(props.getProperty(SYNC_PROPS_KEYS.SHARDS_PROCESSADOS_TOTAL) || '0', 10);
    props.setProperty(SYNC_PROPS_KEYS.SHARDS_PROCESSADOS_TOTAL, String(processadosAtual + processadosNovos));
  }
}

// ===== Calcula o progresso percentual (0-100) da sincronização em andamento =====
// Baseado nos shards REAIS devolvidos pela API conforme vão sendo gravados no
// BigQuery: progresso = shards processados / shards conhecidos até agora.
// O total "conhecido" cresce à medida que cada fonte começa (quando
// descobrimos quantos shards ela tem) - por isso o percentual pode oscilar
// um pouco pra baixo quando uma nova fonte começa, mas sempre reflete o
// progresso real de gravação, sem travar.
function calcularProgressoSincronizacao_() {
  const props = PropertiesService.getScriptProperties();
  const status = props.getProperty(SYNC_PROPS_KEYS.STATUS);

  if (status !== 'IN_PROGRESS') {
    return status === 'DONE' ? 100 : 0;
  }

  const processados = parseInt(props.getProperty(SYNC_PROPS_KEYS.SHARDS_PROCESSADOS_TOTAL) || '0', 10);
  const conhecidos = parseInt(props.getProperty(SYNC_PROPS_KEYS.SHARDS_CONHECIDOS_TOTAL) || '0', 10);

  if (!conhecidos) return 0; // ainda nem começou a processar shard nenhum

  const progresso = (processados / conhecidos) * 100;
  return Math.max(0, Math.min(100, Math.round(progresso)));
}

// ===== Utilitário: consultar o progresso atual sem disparar nada =====
function verificarProgressoSync() {
  const props = PropertiesService.getScriptProperties();
  const status = props.getProperty(SYNC_PROPS_KEYS.STATUS) || 'NENHUMA_SINCRONIZACAO_ATIVA';
  const sourceIndex = props.getProperty(SYNC_PROPS_KEYS.CURRENT_SOURCE_INDEX);
  const nextShard = props.getProperty(SYNC_PROPS_KEYS.NEXT_SHARD);
  const maxShard = props.getProperty(SYNC_PROPS_KEYS.MAX_SHARD);
  const total = props.getProperty(SYNC_PROPS_KEYS.TOTAL_INSERIDAS);
  const tentativas = props.getProperty(SYNC_PROPS_KEYS.RETRY_COUNT);

  Logger.log(`Status: ${status}`);
  if (tentativas && tentativas !== '0') {
    Logger.log(`Tentativas de retry usadas até agora: ${tentativas} (sem limite - continua tentando automaticamente)`);
  }

  if (status === 'IN_PROGRESS' || status === 'DONE' || status === 'ERROR') {
    const idx = parseInt(sourceIndex, 10);
    const sourceKey = (idx < SOURCES.length) ? SOURCES[idx].key : '(concluído)';
    Logger.log(`Fonte atual: ${sourceKey} (${idx + 1} de ${SOURCES.length})`);
    if (nextShard !== null && maxShard !== null) {
      Logger.log(`Progresso do shard: ${nextShard} de ${maxShard} | Linhas gravadas nesta fonte: ${total}`);
    }
  }
}
