function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Loss SOC — Dashboard')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// Chamada pelo front-end (google.script.run) assim que a página do dashboard
// termina de carregar. Dispara a checagem/sincronização definida em DataBase.gs
// e devolve o resultado (+ o grass_datetime da última atualização) para o
// front-end mostrar a mensagem adequada.
//
// startSync() agora faz a checagem de freshness de forma síncrona (rápida) e
// só agenda o trabalho pesado via trigger se realmente houver divergência -
// por isso essa função consegue devolver uma resposta correta na hora:
// 'ja_atualizada' (nada mudou), 'atualizando' (divergência encontrada, trigger
// agendado) ou 'erro' (falha na própria checagem).
//
// A trava de concorrência mora dentro do próprio startSync() (DataBase.gs) e
// vale pra qualquer forma de chamada.
//
// Sem underscore no nome porque funções privadas (com _) não podem ser
// chamadas pelo client-side.
function verificarAtualizacaoAoAbrir() {
  const props = PropertiesService.getScriptProperties();

  if (props.getProperty(SYNC_PROPS_KEYS.STATUS) === 'IN_PROGRESS') {
    return { status: 'atualizando', grassDatetime: obterGrassDatetimeFormatado_() };
  }

  // false = respeita a checagem de grass_datetime (só sincroniza se houver
  // dado novo). Use true aqui apenas se quiser forçar sempre.
  startSync(false);

  const statusFinal = props.getProperty(SYNC_PROPS_KEYS.STATUS);
  const grassDatetime = obterGrassDatetimeFormatado_();

  if (statusFinal === 'IN_PROGRESS') {
    // Divergência encontrada - trigger já agendado, trabalho pesado
    // continua no servidor.
    return { status: 'atualizando', grassDatetime: grassDatetime };
  }

  if (statusFinal === 'ERROR') {
    return { status: 'erro', grassDatetime: grassDatetime };
  }

  // STATUS === 'DONE' -> a checagem rodou e não havia nada pra atualizar.
  return { status: 'ja_atualizada', grassDatetime: grassDatetime };
}

// Chamada pelo front-end em polling (a cada X segundos) enquanto uma
// sincronização está em andamento, só para saber quando ela termina.
// Não inicia nada, só lê o estado atual - leve e seguro pra chamar em loop.
function obterStatusSincronizacao() {
  const props = PropertiesService.getScriptProperties();
  const status = props.getProperty(SYNC_PROPS_KEYS.STATUS);

  return {
    emAndamento: status === 'IN_PROGRESS',
    status: status,
    grassDatetime: obterGrassDatetimeFormatado_()
  };
}

// Lê o grass_datetime mais recente já gravado no BigQuery (tabela oficial da
// fonte de referência "fwd", a mesma usada como referência em DataBase.gs) e
// devolve formatado como dd/MM/yyyy HH:mm. Retorna null se ainda não houver dado.
function obterGrassDatetimeFormatado_() {
  const tabelaReferencia = SOURCES[0].tableId; // 'fwd'
  const bruto = obterUltimoGrassDatetimeBigQuery_(tabelaReferencia);
  const epochMs = normalizarGrassDatetime_(bruto);

  if (epochMs === null) return null;

  return Utilities.formatDate(new Date(epochMs), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm');
}

// Se preferir abrir como sidebar ou modal dentro de uma planilha,
// use esta função em vez do doGet, chamada por um menu ou botão:
function abrirDashboard() {
  var html = HtmlService.createHtmlOutputFromFile('Index')
    .setWidth(1150)
    .setHeight(160);
  SpreadsheetApp.getUi().showModalDialog(html, 'Loss SOC — Dashboard');
}

// Exemplo de menu automático ao abrir a planilha
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Dashboard')
    .addItem('Abrir Loss SOC', 'abrirDashboard')
    .addToUi();
}
