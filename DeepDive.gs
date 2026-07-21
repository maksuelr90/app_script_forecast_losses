// ===================================================================
// ===== ABA DEEP DIVE =====
// ===================================================================
// Análise independente da Projeção Analítica (Analitico.gs) - mesmo que a
// consulta pareça igual hoje, mantém sua própria função aqui de propósito,
// pra evitar que um ajuste futuro numa aba afete a outra sem querer.
// Reaproveita só infraestrutura genérica (executarQuery_, BQ_CONFIG,
// condicaoFiltroEstacao_, paraNumero_), não lógica de negócio de outra aba.

// ===================================================================
// ===== DETALHAMENTO (exportação) - lista de registros individuais =====
// ===================================================================
// Usada pelos botõezinhos de download em cada item das análises: recebe uma
// lista de condições (montadas no front-end, uma por item clicado) e devolve
// os registros da fwd que batem com aquele recorte exato, pra virar um CSV.
//
// Formato de cada condição em condicoesJSON (array de objetos):
//   { tipo: 'igual', campo: 'macro_status'|'last_status'|'perfil_do_pacote', valor: '...' }
//   { tipo: 'flag_sim', campo: 'is_error'|'bip_rejeito'|'is_rr'|'is_sip'|'is_rf' }
//   { tipo: 'actual_igual_station' }               -> actual_station_code = station_code
//   { tipo: 'actual_diferente_station' }            -> actual_station_code != station_code
//   { tipo: 'actual_igual_valor', valor: 'SOC-XX' } -> actual_station_code = 'SOC-XX'
//   { tipo: 'to_completa' }                         -> whole_to = 'SIM' AND qtd_to > 2
//
// Campos/tipos são validados contra uma lista fixa antes de entrar na query -
// não aceita nada fora disso, mesmo vindo do front-end.
const CAMPOS_IGUAL_PERMITIDOS_ = ['macro_status', 'last_status', 'perfil_do_pacote', 'last_linehaul_trip', 'last_to_number'];
const FLAGS_PERMITIDAS_ = ['is_error', 'bip_rejeito', 'is_rr', 'is_sip', 'is_rf'];
const CAMPOS_MAIOR_QUE_PERMITIDOS_ = ['gmv'];

function escaparValorSQL_(valor) {
  return String(valor).replace(/'/g, "''");
}

function obterDetalhamentoFwd(condicoesJSON, filtroEstacao) {
  const condicoes = JSON.parse(condicoesJSON || '[]');

  let where = "station_code LIKE 'SOC-%'";
  const condicaoFiltro = condicaoFiltroEstacao_(filtroEstacao);
  if (condicaoFiltro) where += ' ' + condicaoFiltro;

  condicoes.forEach(function(c) {
    if (c.tipo === 'igual' && CAMPOS_IGUAL_PERMITIDOS_.indexOf(c.campo) !== -1) {
      where += ` AND ${c.campo} = '${escaparValorSQL_(c.valor)}'`;
    } else if (c.tipo === 'flag_sim' && FLAGS_PERMITIDAS_.indexOf(c.campo) !== -1) {
      where += ` AND ${c.campo} = 'SIM'`;
    } else if (c.tipo === 'actual_igual_station') {
      where += ' AND actual_station_code = station_code';
    } else if (c.tipo === 'actual_diferente_station') {
      where += ' AND actual_station_code != station_code';
    } else if (c.tipo === 'actual_igual_valor') {
      where += ` AND actual_station_code = '${escaparValorSQL_(c.valor)}'`;
    } else if (c.tipo === 'to_completa') {
      where += " AND whole_to = 'SIM' AND qtd_to > 2";
    } else if (c.tipo === 'maior_que' && CAMPOS_MAIOR_QUE_PERMITIDOS_.indexOf(c.campo) !== -1) {
      const valorNumerico = Number(c.valor);
      if (!isNaN(valorNumerico)) {
        where += ` AND SAFE_CAST(${c.campo} AS FLOAT64) > ${valorNumerico}`;
      }
    }
  });

  const query = `
    SELECT *
    FROM \`${BQ_CONFIG.PROJECT_ID}.${BQ_CONFIG.DATASET_ID}.inventory_forecast_losses_fwd\`
    WHERE ${where}
    LIMIT 5000
  `;

  return executarQuery_(query);
}

// ===== Distribuição de remessas por status (macro_status + last_status) =====
// Chamada pelo front-end via google.script.run.obterDistribuicaoStatusDeepDive(filtroEstacao).
function obterDistribuicaoStatusDeepDive(filtroEstacao) {
  const query = `
    SELECT
      macro_status,
      last_status,
      COUNT(DISTINCT shipment_id) AS qtd_remessas
    FROM \`${BQ_CONFIG.PROJECT_ID}.${BQ_CONFIG.DATASET_ID}.inventory_forecast_losses_fwd\`
    WHERE station_code LIKE 'SOC-%'
      ${condicaoFiltroEstacao_(filtroEstacao)}
    GROUP BY macro_status, last_status
    ORDER BY qtd_remessas DESC
  `;

  const linhas = executarQuery_(query);
  linhas.forEach(function(l) { l.qtd_remessas = paraNumero_(l.qtd_remessas); });

  const total = linhas.reduce(function(acc, l) { return acc + l.qtd_remessas; }, 0);
  linhas.forEach(function(l) {
    l.percentual = total > 0 ? l.qtd_remessas / total : 0;
  });

  return { total: total, linhas: linhas };
}

// ===================================================================
// ===== ANÁLISE DE CAUSA RAIZ (por macro_status) =====
// ===================================================================
// Monta um "card" por macro_status com: % do total, Loss Rate, detalhamento
// de last_status, Indicadores Críticos (flags is_error/bip_rejeito/is_rr/
// is_sip/is_rf) e o Perfil Predominante (perfil_do_pacote) - e gera um
// insight automático apontando o sinal mais concentrado encontrado.
// Chamada pelo front-end via google.script.run.obterAnaliseCausaRaiz(filtroEstacao).
function obterAnaliseCausaRaiz(filtroEstacao) {
  const condicao = condicaoFiltroEstacao_(filtroEstacao);

  // ===== Distribuição macro_status + last_status =====
  const queryStatus = `
    SELECT macro_status, last_status, COUNT(DISTINCT shipment_id) AS qtd
    FROM \`${BQ_CONFIG.PROJECT_ID}.${BQ_CONFIG.DATASET_ID}.inventory_forecast_losses_fwd\`
    WHERE station_code LIKE 'SOC-%'
      ${condicao}
    GROUP BY macro_status, last_status
  `;
  const statusRows = executarQuery_(queryStatus);
  statusRows.forEach(function(r) { r.qtd = paraNumero_(r.qtd); });

  if (statusRows.length === 0) {
    return { temDados: false };
  }

  const totalGeral = statusRows.reduce(function(acc, r) { return acc + r.qtd; }, 0);

  // ===== Indicadores críticos (flags SIM/NÃO) por macro_status =====
  const queryIndicadores = `
    SELECT
      macro_status,
      COUNT(DISTINCT shipment_id) AS qtd_total,
      COUNT(DISTINCT CASE WHEN is_error = 'SIM' THEN shipment_id END) AS qtd_error,
      COUNT(DISTINCT CASE WHEN bip_rejeito = 'SIM' THEN shipment_id END) AS qtd_bip,
      COUNT(DISTINCT CASE WHEN is_rr = 'SIM' THEN shipment_id END) AS qtd_rr,
      COUNT(DISTINCT CASE WHEN is_sip = 'SIM' THEN shipment_id END) AS qtd_sip,
      COUNT(DISTINCT CASE WHEN is_rf = 'SIM' THEN shipment_id END) AS qtd_rf
    FROM \`${BQ_CONFIG.PROJECT_ID}.${BQ_CONFIG.DATASET_ID}.inventory_forecast_losses_fwd\`
    WHERE station_code LIKE 'SOC-%'
      ${condicao}
    GROUP BY macro_status
  `;

  // ===== GMV em risco por macro_status - foco em pacotes de alto valor (>1000) =====
  const queryGMV = `
    SELECT
      macro_status,
      SUM(SAFE_CAST(gmv AS FLOAT64)) AS gmv_total,
      COUNT(DISTINCT CASE WHEN SAFE_CAST(gmv AS FLOAT64) > 1000 THEN shipment_id END) AS qtd_alto_valor
    FROM \`${BQ_CONFIG.PROJECT_ID}.${BQ_CONFIG.DATASET_ID}.inventory_forecast_losses_fwd\`
    WHERE station_code LIKE 'SOC-%'
      ${condicao}
    GROUP BY macro_status
  `;
  const indicadoresRows = executarQuery_(queryIndicadores);
  indicadoresRows.forEach(function(r) {
    r.qtd_total = paraNumero_(r.qtd_total);
    r.qtd_error = paraNumero_(r.qtd_error);
    r.qtd_bip = paraNumero_(r.qtd_bip);
    r.qtd_rr = paraNumero_(r.qtd_rr);
    r.qtd_sip = paraNumero_(r.qtd_sip);
    r.qtd_rf = paraNumero_(r.qtd_rf);
  });

  const gmvRows = executarQuery_(queryGMV);
  gmvRows.forEach(function(r) {
    r.gmv_total = paraNumero_(r.gmv_total);
    r.qtd_alto_valor = paraNumero_(r.qtd_alto_valor);
  });

  // ===== Perfil predominante (perfil_do_pacote) por macro_status =====
  const queryPerfil = `
    SELECT macro_status, perfil_do_pacote, COUNT(DISTINCT shipment_id) AS qtd
    FROM \`${BQ_CONFIG.PROJECT_ID}.${BQ_CONFIG.DATASET_ID}.inventory_forecast_losses_fwd\`
    WHERE station_code LIKE 'SOC-%'
      AND perfil_do_pacote IS NOT NULL
      ${condicao}
    GROUP BY macro_status, perfil_do_pacote
  `;
  const perfilRows = executarQuery_(queryPerfil);
  perfilRows.forEach(function(r) { r.qtd = paraNumero_(r.qtd); });

  // ===== Volume total (denominador do Loss Rate de cada card) =====
  const queryVolume = `
    SELECT SUM(volume) AS volume
    FROM \`${BQ_CONFIG.PROJECT_ID}.${BQ_CONFIG.DATASET_ID}.inventory_forecast_losses_volume\`
    WHERE station_code LIKE 'SOC-%'
      ${condicao}
  `;
  const volumeRows = executarQuery_(queryVolume);
  const volumeTotal = volumeRows.length > 0 ? paraNumero_(volumeRows[0].volume) : 0;

  // ===== Nomes amigáveis dos indicadores, pro insight ficar legível =====
  const NOMES_INDICADORES = {
    is_error: 'status com erro',
    bip_rejeito: 'Bip no Rejeito',
    is_rr: 'RR Order',
    is_sip: 'SIP',
    is_rf: 'RF'
  };

  const macrosUnicos = statusRows
    .map(function(r) { return r.macro_status; })
    .filter(function(m, i, arr) { return arr.indexOf(m) === i; });

  // ===== TOP 3 Linehaul Trip por macro_status (TODOS de uma vez) =====
  // Antes: 1 query por macro_status dentro do loop de cards (3 macro_status
  // = 3 queries). Padronizado com o mesmo padrão já usado acima pra
  // indicadores/gmv/perfil: 1 query com QUALIFY + ROW_NUMBER, filtrada por
  // macro depois em JS.
  const queryTopLinehaul = `
    SELECT macro_status, last_linehaul_trip, COUNT(DISTINCT shipment_id) AS qtd
    FROM \`${BQ_CONFIG.PROJECT_ID}.${BQ_CONFIG.DATASET_ID}.inventory_forecast_losses_fwd\`
    WHERE station_code LIKE 'SOC-%'
      AND last_linehaul_trip IS NOT NULL
      AND last_linehaul_trip != ''
      ${condicao}
    GROUP BY macro_status, last_linehaul_trip
    QUALIFY ROW_NUMBER() OVER (PARTITION BY macro_status ORDER BY COUNT(DISTINCT shipment_id) DESC) <= 3
    ORDER BY macro_status, qtd DESC
  `;
  const topLinehaulRows = executarQuery_(queryTopLinehaul);
  topLinehaulRows.forEach(function(r) { r.qtd = paraNumero_(r.qtd); });

  // ===== TOP 3 TO / last_to_number por macro_status (TODOS de uma vez) =====
  const queryTopTO = `
    SELECT macro_status, last_to_number, COUNT(DISTINCT shipment_id) AS qtd
    FROM \`${BQ_CONFIG.PROJECT_ID}.${BQ_CONFIG.DATASET_ID}.inventory_forecast_losses_fwd\`
    WHERE station_code LIKE 'SOC-%'
      AND last_to_number IS NOT NULL
      AND last_to_number != ''
      ${condicao}
    GROUP BY macro_status, last_to_number
    QUALIFY ROW_NUMBER() OVER (PARTITION BY macro_status ORDER BY COUNT(DISTINCT shipment_id) DESC) <= 3
    ORDER BY macro_status, qtd DESC
  `;
  const topTORows = executarQuery_(queryTopTO);
  topTORows.forEach(function(r) { r.qtd = paraNumero_(r.qtd); });

  const cards = macrosUnicos.map(function(macro) {
    const linhasDoMacro = statusRows.filter(function(r) { return r.macro_status === macro; });
    const qtdMacro = linhasDoMacro.reduce(function(acc, r) { return acc + r.qtd; }, 0);
    const percentualTotal = totalGeral > 0 ? qtdMacro / totalGeral : 0;
    const lossRate = volumeTotal > 0 ? qtdMacro / volumeTotal : null;

    const subStatus = linhasDoMacro
      .map(function(r) {
        return { last_status: r.last_status, qtd: r.qtd, percentual: qtdMacro > 0 ? r.qtd / qtdMacro : 0 };
      })
      .sort(function(a, b) { return b.qtd - a.qtd; });

    const indRow = indicadoresRows.filter(function(r) { return r.macro_status === macro; })[0];

    const listaIndicadores = indRow ? [
      { chave: 'is_error', qtd: indRow.qtd_error, pct: indRow.qtd_total > 0 ? indRow.qtd_error / indRow.qtd_total : 0 },
      { chave: 'bip_rejeito', qtd: indRow.qtd_bip, pct: indRow.qtd_total > 0 ? indRow.qtd_bip / indRow.qtd_total : 0 },
      { chave: 'is_rr', qtd: indRow.qtd_rr, pct: indRow.qtd_total > 0 ? indRow.qtd_rr / indRow.qtd_total : 0 },
      { chave: 'is_sip', qtd: indRow.qtd_sip, pct: indRow.qtd_total > 0 ? indRow.qtd_sip / indRow.qtd_total : 0 },
      { chave: 'is_rf', qtd: indRow.qtd_rf, pct: indRow.qtd_total > 0 ? indRow.qtd_rf / indRow.qtd_total : 0 }
    ].sort(function(a, b) { return b.pct - a.pct; }) : [];

    const perfisDoMacro = perfilRows
      .filter(function(r) { return r.macro_status === macro; })
      .sort(function(a, b) { return b.qtd - a.qtd; });
    const perfilTop = perfisDoMacro[0] || null;
    const perfilPct = perfilTop && qtdMacro > 0 ? perfilTop.qtd / qtdMacro : null;

    // ===== GMV em risco - foco em pacotes de alto valor (GMV > 1000) =====
    const gmvRow = gmvRows.filter(function(r) { return r.macro_status === macro; })[0];
    const gmvTotal = gmvRow ? gmvRow.gmv_total : 0;
    const qtdAltoValor = gmvRow ? gmvRow.qtd_alto_valor : 0;
    const percentualAltoValor = qtdMacro > 0 ? qtdAltoValor / qtdMacro : 0;

    // ===== TOP 3 Linehaul Trip (concentração por viagem específica) =====
    // Filtra em JS a partir de topLinehaulRows (já consolidado acima, 1 query
    // só pra todos os macro_status - não dispara mais 1 query por card).
    const topLinehaulTrip = topLinehaulRows
      .filter(function(r) { return r.macro_status === macro; })
      .map(function(r) {
        return { valor: r.last_linehaul_trip, qtd: r.qtd, percentual: qtdMacro > 0 ? r.qtd / qtdMacro : 0 };
      });

    // ===== TOP 3 TO / last_to_number (concentração por TO específica) =====
    // Mesmo padrão: filtra em JS a partir de topTORows já consolidado.
    const topTO = topTORows
      .filter(function(r) { return r.macro_status === macro; })
      .map(function(r) {
        return { valor: r.last_to_number, qtd: r.qtd, percentual: qtdMacro > 0 ? r.qtd / qtdMacro : 0 };
      });

    // ===== Insight automático: aponta o sinal mais concentrado encontrado =====
    let insight;
    const indicadorTop = listaIndicadores[0];

    if (indicadorTop && indicadorTop.pct >= 0.15) {
      insight = (indicadorTop.pct * 100).toFixed(0) + '% dos pacotes em ' + macro +
        ' têm ' + NOMES_INDICADORES[indicadorTop.chave] + '.';
    } else if (perfilTop && perfilPct >= 0.4) {
      insight = 'Perfil ' + perfilTop.perfil_do_pacote + ' concentra ' +
        (perfilPct * 100).toFixed(0) + '% dos pacotes em ' + macro + '.';
    } else {
      insight = 'Nenhum sinal fortemente concentrado identificado neste status.';
    }

    return {
      macro_status: macro,
      qtd: qtdMacro,
      percentualTotal: percentualTotal,
      lossRate: lossRate,
      subStatus: subStatus,
      indicadores: listaIndicadores,
      perfilPredominante: perfilTop ? { perfil: perfilTop.perfil_do_pacote, qtd: perfilTop.qtd, percentual: perfilPct } : null,
      gmvTotal: gmvTotal,
      altoValor: { qtd: qtdAltoValor, percentual: percentualAltoValor },
      topLinehaulTrip: topLinehaulTrip,
      topTO: topTO,
      insight: insight
    };
  }).sort(function(a, b) { return b.qtd - a.qtd; });

  // ===== Tratamento específico do card SOC_Packed =====
  // Separa "parado no SOC sem handover" (station_code = actual_station_code)
  // de "recebimento massivo no destino" (actual_station_code diferente de
  // station_code - o pacote já saiu e chegou em outra estação, mas não foi
  // processado lá). Só se aplica a esse macro_status especificamente.
  const cardPacked = cards.filter(function(c) { return c.macro_status === 'SOC_Packed'; })[0];

  if (cardPacked) {
    // ===== Recebimento massivo: total + TOP 3 estações destino, numa query só =====
    // Antes: queryMassivo (só o total) e queryFanout (top 3 por estação)
    // eram 2 queries com o MESMO filtro base - mesmo padrão mecânico já
    // consolidado acima (agregado + SUM(...) OVER() pro total, QUALIFY +
    // ROW_NUMBER() pro top 3).
    const queryMassivoDetalhado = `
      WITH agregado AS (
        SELECT actual_station_code, COUNT(DISTINCT shipment_id) AS qtd
        FROM \`${BQ_CONFIG.PROJECT_ID}.${BQ_CONFIG.DATASET_ID}.inventory_forecast_losses_fwd\`
        WHERE station_code LIKE 'SOC-%'
          AND macro_status = 'SOC_Packed'
          AND actual_station_code != station_code
          ${condicao}
        GROUP BY actual_station_code
      )
      SELECT actual_station_code, qtd, SUM(qtd) OVER () AS total
      FROM agregado
      QUALIFY ROW_NUMBER() OVER (ORDER BY qtd DESC) <= 3
      ORDER BY qtd DESC
    `;
    const massivoDetalhadoRows = executarQuery_(queryMassivoDetalhado);
    massivoDetalhadoRows.forEach(function(r) { r.qtd = paraNumero_(r.qtd); r.total = paraNumero_(r.total); });
    const qtdMassivo = massivoDetalhadoRows.length > 0 ? massivoDetalhadoRows[0].total : 0;
    const fanoutRows = massivoDetalhadoRows;

    const querySubStatusFiltrado = `
      SELECT last_status, COUNT(DISTINCT shipment_id) AS qtd
      FROM \`${BQ_CONFIG.PROJECT_ID}.${BQ_CONFIG.DATASET_ID}.inventory_forecast_losses_fwd\`
      WHERE station_code LIKE 'SOC-%'
        AND macro_status = 'SOC_Packed'
        AND actual_station_code = station_code
        ${condicao}
      GROUP BY last_status
      ORDER BY qtd DESC
      LIMIT 3
    `;
    const subStatusFiltradoRows = executarQuery_(querySubStatusFiltrado);
    subStatusFiltradoRows.forEach(function(r) { r.qtd = paraNumero_(r.qtd); });

    const qtdNaoMassivo = cardPacked.qtd - qtdMassivo;

    cardPacked.percentualRecebimentoMassivo = cardPacked.qtd > 0 ? qtdMassivo / cardPacked.qtd : 0;
    cardPacked.qtdRecebimentoMassivo = qtdMassivo;

    // Top 3 fanout ofensores - item de TOPO, então % é em cima do total do
    // status (cardPacked.qtd), não do total de recebimento massivo.
    cardPacked.topFanoutOfensores = fanoutRows.map(function(r) {
      return {
        estacao: r.actual_station_code,
        qtd: r.qtd,
        percentual: cardPacked.qtd > 0 ? r.qtd / cardPacked.qtd : 0
      };
    });

    // Sub-status agora reflete só os pacotes SEM recebimento massivo
    // (station_code = actual_station_code), já limitado ao TOP 3. Item de
    // TOPO, então % é em cima do total do status (cardPacked.qtd).
    cardPacked.subStatus = subStatusFiltradoRows.map(function(r) {
      return {
        last_status: r.last_status,
        qtd: r.qtd,
        percentual: cardPacked.qtd > 0 ? r.qtd / cardPacked.qtd : 0
      };
    });

    // ===== Função auxiliar: busca os 5 indicadores críticos com uma
    // condição extra qualquer (reaproveitada abaixo pra recalcular só sobre
    // não-massivo, e também pro detalhamento do Top 1 Fanout Ofensor).
    // denominadorExterno: se informado, usa esse valor pro cálculo do %
    // em vez do total da própria consulta filtrada - necessário quando o
    // item é de TOPO (% deve ser sobre o total do status, não sobre o
    // subconjunto filtrado usado só pra contar). Quando omitido, usa o
    // próprio total filtrado (comportamento certo pra ramificações, cujo
    // "pai" já É esse subconjunto). =====
    function obterIndicadores_(condicaoExtra, denominadorExterno) {
      const query = `
        SELECT
          COUNT(DISTINCT shipment_id) AS qtd_total,
          COUNT(DISTINCT CASE WHEN is_error = 'SIM' THEN shipment_id END) AS qtd_error,
          COUNT(DISTINCT CASE WHEN bip_rejeito = 'SIM' THEN shipment_id END) AS qtd_bip,
          COUNT(DISTINCT CASE WHEN is_rr = 'SIM' THEN shipment_id END) AS qtd_rr,
          COUNT(DISTINCT CASE WHEN is_sip = 'SIM' THEN shipment_id END) AS qtd_sip,
          COUNT(DISTINCT CASE WHEN is_rf = 'SIM' THEN shipment_id END) AS qtd_rf
        FROM \`${BQ_CONFIG.PROJECT_ID}.${BQ_CONFIG.DATASET_ID}.inventory_forecast_losses_fwd\`
        WHERE station_code LIKE 'SOC-%'
          AND macro_status = 'SOC_Packed'
          ${condicao}
          ${condicaoExtra}
      `;
      const rows = executarQuery_(query);
      if (rows.length === 0) return [];

      const r = rows[0];
      const qtdTotal = denominadorExterno !== undefined ? denominadorExterno : paraNumero_(r.qtd_total);
      const bruto = {
        is_error: paraNumero_(r.qtd_error),
        bip_rejeito: paraNumero_(r.qtd_bip),
        is_rr: paraNumero_(r.qtd_rr),
        is_sip: paraNumero_(r.qtd_sip),
        is_rf: paraNumero_(r.qtd_rf)
      };

      return Object.keys(bruto).map(function(chave) {
        return { chave: chave, qtd: bruto[chave], pct: qtdTotal > 0 ? bruto[chave] / qtdTotal : 0 };
      }).sort(function(a, b) { return b.pct - a.pct; });
    }

    // Indicadores Críticos do card SOC_Packed: contagem só sobre o grupo
    // sem recebimento massivo, mas item de TOPO -> % em cima do total do
    // status inteiro (cardPacked.qtd), não do subgrupo usado pra contar.
    cardPacked.indicadores = obterIndicadores_('AND actual_station_code = station_code', cardPacked.qtd);

    // Detalhamento aprofundado do maior Fanout Ofensor (#1 do TOP 3) - a
    // ideia é chegar o mais perto possível da causa raiz daquele destino
    // específico, então trazemos TUDO que der sinal: indicadores críticos
    // (sem cortar em 5%, só oculta o que é zero), sub-status, perfil
    // predominante e TO Completa, todos filtrados só pra essa estação.
    if (cardPacked.topFanoutOfensores.length > 0) {
      const top1 = cardPacked.topFanoutOfensores[0];
      const estacaoTop1 = top1.estacao;
      const condicaoTop1 = `AND actual_station_code != station_code AND actual_station_code = '${estacaoTop1}'`;

      top1.indicadores = obterIndicadores_(condicaoTop1);

      const querySubStatusTop1 = `
        SELECT last_status, COUNT(DISTINCT shipment_id) AS qtd
        FROM \`${BQ_CONFIG.PROJECT_ID}.${BQ_CONFIG.DATASET_ID}.inventory_forecast_losses_fwd\`
        WHERE station_code LIKE 'SOC-%'
          AND macro_status = 'SOC_Packed'
          ${condicao}
          ${condicaoTop1}
        GROUP BY last_status
        ORDER BY qtd DESC
        LIMIT 3
      `;
      const subStatusTop1Rows = executarQuery_(querySubStatusTop1);
      subStatusTop1Rows.forEach(function(r) { r.qtd = paraNumero_(r.qtd); });
      top1.subStatus = subStatusTop1Rows.map(function(r) {
        return { last_status: r.last_status, qtd: r.qtd, percentual: top1.qtd > 0 ? r.qtd / top1.qtd : 0 };
      });

      const queryPerfilTop1 = `
        SELECT perfil_do_pacote, COUNT(DISTINCT shipment_id) AS qtd
        FROM \`${BQ_CONFIG.PROJECT_ID}.${BQ_CONFIG.DATASET_ID}.inventory_forecast_losses_fwd\`
        WHERE station_code LIKE 'SOC-%'
          AND macro_status = 'SOC_Packed'
          AND perfil_do_pacote IS NOT NULL
          ${condicao}
          ${condicaoTop1}
        GROUP BY perfil_do_pacote
        ORDER BY qtd DESC
        LIMIT 1
      `;
      const perfilTop1Rows = executarQuery_(queryPerfilTop1);
      if (perfilTop1Rows.length > 0) {
        const p = perfilTop1Rows[0];
        const qtdPerfil = paraNumero_(p.qtd);
        top1.perfilPredominante = { perfil: p.perfil_do_pacote, qtd: qtdPerfil, percentual: top1.qtd > 0 ? qtdPerfil / top1.qtd : 0 };
      }

      const queryTOCompletaTop1 = `
        SELECT COUNT(DISTINCT shipment_id) AS qtd
        FROM \`${BQ_CONFIG.PROJECT_ID}.${BQ_CONFIG.DATASET_ID}.inventory_forecast_losses_fwd\`
        WHERE station_code LIKE 'SOC-%'
          AND macro_status = 'SOC_Packed'
          AND whole_to = 'SIM'
          AND qtd_to > 2
          ${condicao}
          ${condicaoTop1}
      `;
      const toCompletaTop1Rows = executarQuery_(queryTOCompletaTop1);
      const qtdTOCompletaTop1 = toCompletaTop1Rows.length > 0 ? paraNumero_(toCompletaTop1Rows[0].qtd) : 0;
      top1.toCompleta = { qtd: qtdTOCompletaTop1, percentual: top1.qtd > 0 ? qtdTOCompletaTop1 / top1.qtd : 0 };
    }

    // ===== TO Completa (whole_to = 'SIM' AND qtd_to > 2) - calculado
    // separadamente pros dois grupos (recebimento massivo vs sem handover),
    // pra ver se esse padrão de TO completa concentra mais num grupo ou noutro.
    // ===== TO Completa + Recebimento Massivo: total + TOP 3 estações, numa
    // query só (mesmo padrão mecânico usado acima) =====
    const queryTOCompletaMassivoDetalhado = `
      WITH agregado AS (
        SELECT actual_station_code, COUNT(DISTINCT shipment_id) AS qtd
        FROM \`${BQ_CONFIG.PROJECT_ID}.${BQ_CONFIG.DATASET_ID}.inventory_forecast_losses_fwd\`
        WHERE station_code LIKE 'SOC-%'
          AND macro_status = 'SOC_Packed'
          AND actual_station_code != station_code
          AND whole_to = 'SIM'
          AND qtd_to > 2
          ${condicao}
        GROUP BY actual_station_code
      )
      SELECT actual_station_code, qtd, SUM(qtd) OVER () AS total
      FROM agregado
      QUALIFY ROW_NUMBER() OVER (ORDER BY qtd DESC) <= 3
      ORDER BY qtd DESC
    `;
    const toCompletaMassivoDetalhadoRows = executarQuery_(queryTOCompletaMassivoDetalhado);
    toCompletaMassivoDetalhadoRows.forEach(function(r) { r.qtd = paraNumero_(r.qtd); r.total = paraNumero_(r.total); });
    const qtdTOCompletaMassivo = toCompletaMassivoDetalhadoRows.length > 0 ? toCompletaMassivoDetalhadoRows[0].total : 0;
    const toCompletaMassivoPorEstacaoRows = toCompletaMassivoDetalhadoRows;

    const queryTOCompletaNaoMassivo = `
      SELECT COUNT(DISTINCT shipment_id) AS qtd
      FROM \`${BQ_CONFIG.PROJECT_ID}.${BQ_CONFIG.DATASET_ID}.inventory_forecast_losses_fwd\`
      WHERE station_code LIKE 'SOC-%'
        AND macro_status = 'SOC_Packed'
        AND actual_station_code = station_code
        AND whole_to = 'SIM'
        AND qtd_to > 2
        ${condicao}
    `;
    const toCompletaNaoMassivoRows = executarQuery_(queryTOCompletaNaoMassivo);
    const qtdTOCompletaNaoMassivo = toCompletaNaoMassivoRows.length > 0 ? paraNumero_(toCompletaNaoMassivoRows[0].qtd) : 0;

    // "TO Completa (Recebimento Massivo)" é item de TOPO dentro de
    // Indicadores Críticos -> % em cima do total do status (cardPacked.qtd).
    // Já "↳ TO Completa" (sem massivo) é RAMIFICAÇÃO da linha 'SOC_Packed'
    // no sub-status -> % em cima do qtd dessa linha específica, não do total.
    const linhaSocPackedSubStatus = cardPacked.subStatus.filter(function(s) { return s.last_status === 'SOC_Packed'; })[0];
    const qtdSocPackedSubStatus = linhaSocPackedSubStatus ? linhaSocPackedSubStatus.qtd : 0;

    cardPacked.toCompleta = {
      massivo: {
        qtd: qtdTOCompletaMassivo,
        percentual: cardPacked.qtd > 0 ? qtdTOCompletaMassivo / cardPacked.qtd : 0,
        topEstacoes: toCompletaMassivoPorEstacaoRows.map(function(r) {
          return {
            estacao: r.actual_station_code,
            qtd: r.qtd,
            percentual: qtdTOCompletaMassivo > 0 ? r.qtd / qtdTOCompletaMassivo : 0
          };
        })
      },
      naoMassivo: {
        qtd: qtdTOCompletaNaoMassivo,
        percentual: qtdSocPackedSubStatus > 0 ? qtdTOCompletaNaoMassivo / qtdSocPackedSubStatus : 0
      }
    };
  }

  return { temDados: true, totalGeral: totalGeral, cards: cards };
}
