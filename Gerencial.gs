// ===================================================================
// ===== DADOS DO PAINEL GERENCIAL =====
// ===================================================================
// Visão de TENDÊNCIA: cruza Volume processado + Losses realizados + Forecast
// de losses (tabela fwd), do mês anterior até o mais recente, com corte
// semana a semana e fechamento mensal. Duas visões:
//   - Overall: todos os SOCs somados
//   - Sorter: apenas os SOCs com sorter (RJ2, SP2, SP8)
//
// Regras de negócio confirmadas:
//   - Forecast de losses = COUNT(DISTINCT shipment_id) na tabela fwd
//     (cada shipment_id é 1 perda projetada, sem filtro de status)
//   - Agrupamento por SOC usa station_code (estação de origem)
//   - As colunas mes/semana da fwd são baseadas em data_base_loss

const SORTER_STATIONS = ['SP8', 'RJ2', 'SP2'];

// Chamada pelo front-end via google.script.run.obterDadosGerencial(filtroEstacao).
// filtroEstacao:
//   'OVERALL' (ou vazio/undefined) -> todos os SOCs
//   'GROUP:SORTER'                 -> SOC-SP8, SOC-RJ2, SOC-SP2
//   'GROUP:REGI'                   -> todos os SOCs de SP (exceto os do Sorter)
//   'GROUP:REGII'                  -> todos os SOCs fora de SP (exceto os do Sorter)
//   qualquer outro valor (ex: 'PR1') -> filtra só aquela estação específica
function obterDadosGerencial(filtroEstacao) {
  const hoje = new Date();
  const dataMesAnterior = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);

  const dataInicio = Utilities.formatDate(dataMesAnterior, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const dataFim = Utilities.formatDate(hoje, Session.getScriptTimeZone(), 'yyyy-MM-dd');

  // Mapeia cada número de mês (1-12) presente no período pro ano certo -
  // necessário porque mes/semana nas tabelas de origem não têm coluna de
  // ano, mas ref_year existe na tabela de targets e precisamos bater certo
  // (importante especialmente se o período cruzar dez/jan).
  const mesParaAno = {};
  mesParaAno[dataMesAnterior.getMonth() + 1] = dataMesAnterior.getFullYear();
  mesParaAno[hoje.getMonth() + 1] = hoje.getFullYear();

  const volumeRows = obterVolumePorSemana_(dataInicio, dataFim);
  const lossesRows = obterLossesPorSemana_(dataInicio, dataFim);
  const forecastRows = obterForecastPorSemana_(dataInicio, dataFim);
  const targetsRows = obterTargetsPorMes_(mesParaAno);

  let filtro = null; // null = Overall (todos os SOCs)

  if (filtroEstacao === 'GROUP:SORTER') {
    filtro = SORTER_STATIONS;
  } else if (filtroEstacao === 'GROUP:REGI') {
    filtro = obterListaEstacoesAgrupadas().regI;
  } else if (filtroEstacao === 'GROUP:REGII') {
    filtro = obterListaEstacoesAgrupadas().regII;
  } else if (filtroEstacao && filtroEstacao !== 'OVERALL') {
    filtro = [filtroEstacao];
  }

  return {
    periodo: { inicio: dataInicio, fim: dataFim },
    filtro: filtro ? filtroEstacao : 'OVERALL',
    dados: consolidar_(volumeRows, lossesRows, forecastRows, targetsRows, mesParaAno, filtro)
  };
}

// ===================================================================
// ===== RANKING DE SOCs (pior para melhor) =====
// ===================================================================
// Traz TODOS os SOCs individualmente (semana a semana), e ordena do pior
// pro melhor com base na variação (Rate - Target) do MÊS ATUAL consolidado -
// quanto maior essa variação (rate acima do target), pior o ranking.
// Chamada pelo front-end via google.script.run.obterRankingSOCs().
// Chamada pelo front-end via google.script.run.obterRankingSOCs(filtroEstacao).
// filtroEstacao:
//   'OVERALL' (ou vazio) -> lista completa, sem destaque
//   'GROUP:SORTER'/'GROUP:REGI'/'GROUP:REGII' -> lista FILTRADA só com os SOCs daquele grupo
//   um código específico (ex: 'SP2') -> lista completa, com esse SOC marcado como destaque
//
// Colunas devolvidas por estação:
//   rateAnterior     - Loss Rate do mês anterior ((losses+forecast)/volume)
//   rateAtual        - Loss Rate do mês atual
//   targetAtual      - Target do mês atual
//   variacaoPP       - (rateAtual - targetAtual) em pontos percentuais
//   totalPerdasAtual - losses + forecast_losses do mês atual (contagem absoluta)
//   tetoPerdas       - target * volume do mês atual (quantas perdas "cabem" no target)
function obterRankingSOCs(filtroEstacao) {
  const hoje = new Date();
  const dataMesAnterior = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);
  const dataInicio = Utilities.formatDate(dataMesAnterior, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const dataFim = Utilities.formatDate(hoje, Session.getScriptTimeZone(), 'yyyy-MM-dd');

  const mesParaAno = {};
  mesParaAno[dataMesAnterior.getMonth() + 1] = dataMesAnterior.getFullYear();
  mesParaAno[hoje.getMonth() + 1] = hoje.getFullYear();
  const mesAnteriorNum = dataMesAnterior.getMonth() + 1;
  const mesAtualNum = hoje.getMonth() + 1;

  const volumeRows = obterVolumePorSemana_(dataInicio, dataFim);
  const lossesRows = obterLossesPorSemana_(dataInicio, dataFim);
  const forecastRows = obterForecastPorSemana_(dataInicio, dataFim);
  const targetsRows = obterTargetsPorMes_(mesParaAno);

  // Agrupa volume/losses/forecast por estação, depois por semana dentro de cada estação.
  const porEstacao = {};
  function garantirEstacao(codigo) {
    if (!porEstacao[codigo]) porEstacao[codigo] = {};
    return porEstacao[codigo];
  }

  function acumular(rows, campo) {
    rows.forEach(function(r) {
      const est = garantirEstacao(r.station_code);
      const key = r.mes + '-' + r.semana;
      if (!est[key]) est[key] = { mes: r.mes, semana: r.semana, volume: 0, losses: 0, forecast_losses: 0 };
      est[key][campo] += r[campo] || 0;
    });
  }

  acumular(volumeRows, 'volume');
  acumular(lossesRows, 'losses');
  acumular(forecastRows, 'forecast_losses');

  // Target por estação/mês (direto - não precisa de ponderação, é 1 estação só).
  const targetPorEstacaoMes = {};
  targetsRows.forEach(function(t) {
    if (t.station_code === 'OVERALL') return;
    const ano = mesParaAno[t.mes];
    if (t.ref_year !== ano) return;
    targetPorEstacaoMes[t.station_code + '-' + t.mes] = t.target_loss_rate;
  });

  // Monta a linha de cada estação.
  const socs = Object.keys(porEstacao).sort().map(function(codigo) {
    const dadosSemana = porEstacao[codigo];

    // Consolida volume/losses/forecast de um mês específico pra essa estação.
    function consolidarMes(numeroMes) {
      let volume = 0, losses = 0, forecast_losses = 0;
      Object.keys(dadosSemana).forEach(function(key) {
        const d = dadosSemana[key];
        if (d.mes === numeroMes) {
          volume += d.volume;
          losses += d.losses;
          forecast_losses += d.forecast_losses;
        }
      });
      return {
        volume: volume,
        losses: losses,
        forecast_losses: forecast_losses,
        rate: volume > 0 ? (losses + forecast_losses) / volume : null
      };
    }

    const anterior = consolidarMes(mesAnteriorNum);
    const atual = consolidarMes(mesAtualNum);

    const targetBruto = targetPorEstacaoMes[codigo + '-' + mesAtualNum];
    const targetAtual = targetBruto === undefined ? null : targetBruto;

    const variacaoPP = (atual.rate !== null && targetAtual !== null)
      ? (atual.rate - targetAtual) * 100
      : null;

    const totalPerdasAtual = atual.losses + atual.forecast_losses;
    const tetoPerdas = (targetAtual !== null && atual.volume > 0) ? targetAtual * atual.volume : null;

    // Critério de ordenação: com target -> variação real; sem target -> o
    // próprio rate (quanto maior, pior), pra continuar entrando na disputa
    // do ranking em vez de sempre ir pro final.
    const criterioOrdenacao = atual.rate === null
      ? null
      : (atual.rate - (targetAtual !== null ? targetAtual : 0));

    return {
      station_code: codigo,
      rateAnterior: anterior.rate,
      rateAtual: atual.rate,
      targetAtual: targetAtual,
      variacaoPP: variacaoPP,
      totalPerdasAtual: totalPerdasAtual,
      tetoPerdas: tetoPerdas,
      semTarget: targetAtual === null,
      criterioOrdenacao: criterioOrdenacao
    };
  });

  // Pior pro melhor: maior critério de ordenação primeiro. Só ficam de fora
  // da disputa (final da lista) as estações sem NENHUM dado no mês atual.
  socs.sort(function(a, b) {
    if (a.criterioOrdenacao === null && b.criterioOrdenacao === null) return 0;
    if (a.criterioOrdenacao === null) return 1;
    if (b.criterioOrdenacao === null) return -1;
    return b.criterioOrdenacao - a.criterioOrdenacao;
  });

  // ===== Aplica o filtro selecionado no dashboard =====
  let socsFiltrados = socs;
  let destaque = null;

  if (filtroEstacao === 'GROUP:SORTER') {
    socsFiltrados = socs.filter(function(s) { return SORTER_STATIONS.indexOf(s.station_code) !== -1; });
  } else if (filtroEstacao === 'GROUP:REGI' || filtroEstacao === 'GROUP:REGII') {
    const grupos = obterListaEstacoesAgrupadas();
    const lista = filtroEstacao === 'GROUP:REGI' ? grupos.regI : grupos.regII;
    socsFiltrados = socs.filter(function(s) { return lista.indexOf(s.station_code) !== -1; });
  } else if (filtroEstacao && filtroEstacao !== 'OVERALL') {
    // SOC específico -> mantém a lista completa, só marca ele como destaque.
    destaque = filtroEstacao;
  }

  return {
    mesAnterior: mesAnteriorNum,
    mesAtual: mesAtualNum,
    socs: socsFiltrados,
    destaque: destaque
  };
}

// ===== Lista de SOCs organizada em grupos (Sorter / Reg I - SP / Reg II - fora de SP) =====
// Usada pelo front-end pra montar o <select> com <optgroup>, e reaproveitada
// aqui mesmo pra resolver os filtros GROUP:REGI / GROUP:REGII.
function obterListaEstacoesAgrupadas() {
  const todas = obterListaEstacoes();
  const sorter = SORTER_STATIONS.filter(function(s) { return todas.indexOf(s) !== -1; });
  const restantes = todas.filter(function(s) { return SORTER_STATIONS.indexOf(s) === -1; });
  const regI = restantes.filter(function(s) { return s.indexOf('SP') === 0; });
  const regII = restantes.filter(function(s) { return s.indexOf('SP') !== 0; });

  return { sorter: sorter, regI: regI, regII: regII };
}

// ===== Lista de SOCs disponíveis (pra popular o seletor no front-end) =====
// Usa a tabela de volume como referência (é a que sempre tem dado de todo
// SOC ativo). Devolve sem o prefixo 'SOC-', em ordem alfabética.
// Só considera station_code que comece com 'SOC-' (filtro definitivo -
// qualquer outra coisa na base, seja FBS, FMH ou o que vier no futuro, fica
// de fora automaticamente).
function obterListaEstacoes() {
  const query = `
    SELECT DISTINCT REPLACE(station_code, 'SOC-', '') AS station_code
    FROM \`${BQ_CONFIG.PROJECT_ID}.${BQ_CONFIG.DATASET_ID}.inventory_forecast_losses_volume\`
    WHERE station_code LIKE 'SOC-%'
    ORDER BY station_code
  `;
  return executarQuery_(query).map(function(r) { return r.station_code; });
}

// ===== Targets (metas) por estação/ano/mês, só para os meses do período em uso =====
function obterTargetsPorMes_(mesParaAno) {
  const condicoes = Object.keys(mesParaAno)
    .map(function(mes) { return `(ref_year = ${mesParaAno[mes]} AND ref_month = ${mes})`; })
    .join(' OR ');

  const query = `
    SELECT
      REPLACE(station_code, 'SOC-', '') AS station_code,
      ref_year,
      ref_month AS mes,
      target_loss_rate
    FROM \`${BQ_CONFIG.PROJECT_ID}.${BQ_CONFIG.DATASET_ID}.inventory_forecast_losses_targets\`
    WHERE ${condicoes}
  `;
  return executarQuery_(query);
}

// ===== Volume processado, por estação/semana/mês =====
// Só considera station_code que comece com 'SOC-'.
function obterVolumePorSemana_(dataInicio, dataFim) {
  const query = `
    SELECT
      REPLACE(station_code, 'SOC-', '') AS station_code,
      semana,
      mes,
      SUM(volume) AS volume
    FROM \`${BQ_CONFIG.PROJECT_ID}.${BQ_CONFIG.DATASET_ID}.inventory_forecast_losses_volume\`
    WHERE dia >= DATE('${dataInicio}') AND dia <= DATE('${dataFim}')
      AND station_code LIKE 'SOC-%'
    GROUP BY station_code, semana, mes
  `;
  return executarQuery_(query);
}

// ===== Losses realizados, por estação/semana/mês =====
// Só considera station_code que comece com 'SOC-'.
function obterLossesPorSemana_(dataInicio, dataFim) {
  const query = `
    SELECT
      REPLACE(station_code, 'SOC-', '') AS station_code,
      semana,
      mes,
      SUM(losses) AS losses
    FROM \`${BQ_CONFIG.PROJECT_ID}.${BQ_CONFIG.DATASET_ID}.inventory_forecast_losses_losses\`
    WHERE data_base_loss >= DATE('${dataInicio}') AND data_base_loss <= DATE('${dataFim}')
      AND station_code LIKE 'SOC-%'
    GROUP BY station_code, semana, mes
  `;
  return executarQuery_(query);
}

// ===== Forecast de losses (fwd), por estação/semana/mês =====
// Só considera station_code que comece com 'SOC-'.
function obterForecastPorSemana_(dataInicio, dataFim) {
  const query = `
    SELECT
      REPLACE(station_code, 'SOC-', '') AS station_code,
      semana,
      mes,
      COUNT(DISTINCT shipment_id) AS forecast_losses
    FROM \`${BQ_CONFIG.PROJECT_ID}.${BQ_CONFIG.DATASET_ID}.inventory_forecast_losses_fwd\`
    WHERE data_base_loss >= DATE('${dataInicio}') AND data_base_loss <= DATE('${dataFim}')
      AND station_code LIKE 'SOC-%'
    GROUP BY station_code, semana, mes
  `;
  return executarQuery_(query);
}

// ===== Executa a query e devolve como array de objetos =====
function executarQuery_(query) {
  const response = BigQuery.Jobs.query(
    { query: query, useLegacySql: false, location: BQ_CONFIG.LOCATION },
    BQ_CONFIG.PROJECT_ID
  );
  return linhasBigQueryParaObjetos_(response);
}

// ===== Converte o resultado bruto do BigQuery.Jobs.query em array de objetos =====
function linhasBigQueryParaObjetos_(response) {
  if (!response.rows || response.rows.length === 0) return [];

  const campos = response.schema.fields.map(function(f) { return f.name; });
  const camposNumericos = ['volume', 'losses', 'forecast_losses', 'semana', 'mes', 'target_loss_rate', 'ref_year', 'qtd_remessas', 'aging_by_loss'];

  return response.rows.map(function(row) {
    const obj = {};
    row.f.forEach(function(cell, i) {
      const nomeCampo = campos[i];
      let valor = cell.v;
      if (valor !== null && valor !== undefined && camposNumericos.indexOf(nomeCampo) !== -1) {
        valor = Number(valor);
      }
      obj[nomeCampo] = valor === undefined ? null : valor;
    });
    return obj;
  });
}

// ===== Junta volume + losses + forecast + target por semana/mês, filtrando estações se necessário =====
// filtroEstacoes = null => todos os SOCs (Overall). Array => só os SOCs da lista (ex: Sorters).
function consolidar_(volumeRows, lossesRows, forecastRows, targetsRows, mesParaAno, filtroEstacoes) {
  function filtrar(rows) {
    if (!filtroEstacoes) return rows;
    return rows.filter(function(r) { return filtroEstacoes.indexOf(r.station_code) !== -1; });
  }

  const mapaSemanal = {};

  function acumular(rows, campo) {
    filtrar(rows).forEach(function(r) {
      const key = r.mes + '-' + r.semana;
      if (!mapaSemanal[key]) {
        mapaSemanal[key] = { mes: r.mes, semana: r.semana, volume: 0, losses: 0, forecast_losses: 0 };
      }
      mapaSemanal[key][campo] += r[campo] || 0;
    });
  }

  acumular(volumeRows, 'volume');
  acumular(lossesRows, 'losses');
  acumular(forecastRows, 'forecast_losses');

  const semanal = Object.keys(mapaSemanal)
    .map(function(k) { return mapaSemanal[k]; })
    .sort(function(a, b) { return (a.mes - b.mes) || (a.semana - b.semana); });

  semanal.forEach(function(s) {
    s.loss_rate = s.volume > 0 ? s.losses / s.volume : null;
    s.forecast_rate = s.volume > 0 ? s.forecast_losses / s.volume : null;
  });

  // Fechamento mensal (soma das semanas de cada mês)
  const mapaMensal = {};
  semanal.forEach(function(s) {
    if (!mapaMensal[s.mes]) {
      mapaMensal[s.mes] = { mes: s.mes, volume: 0, losses: 0, forecast_losses: 0 };
    }
    mapaMensal[s.mes].volume += s.volume;
    mapaMensal[s.mes].losses += s.losses;
    mapaMensal[s.mes].forecast_losses += s.forecast_losses;
  });

  const mensal = Object.keys(mapaMensal)
    .map(function(k) { return mapaMensal[k]; })
    .sort(function(a, b) { return a.mes - b.mes; });

  mensal.forEach(function(m) {
    m.loss_rate = m.volume > 0 ? m.losses / m.volume : null;
    m.forecast_rate = m.volume > 0 ? m.forecast_losses / m.volume : null;
  });

  // ===== Target do mês =====
  // Overall usa a linha consolidada 'OVERALL' cadastrada direto na tabela de
  // targets (sem precisar calcular média ponderada). Outros filtros (ex:
  // Sorters) continuam usando a média ponderada por volume entre as
  // estações do filtro, já que ainda não existe uma linha consolidada pra eles.
  const targetsFiltrados = filtrar(targetsRows);

  if (!filtroEstacoes) {
    // ===== Overall: pega direto a linha 'OVERALL' da tabela de targets =====
    mensal.forEach(function(m) {
      const ano = mesParaAno[m.mes];
      const linhaOverall = targetsRows.filter(function(t) {
        return t.station_code === 'OVERALL' && t.mes === m.mes && t.ref_year === ano;
      })[0];
      m.target_rate = linhaOverall ? linhaOverall.target_loss_rate : null;
    });
  } else {
    // ===== Demais filtros (ex: Sorters): média ponderada por volume =====
    const volumePorEstacaoMes = {};
    filtrar(volumeRows).forEach(function(r) {
      const key = r.station_code + '-' + r.mes;
      volumePorEstacaoMes[key] = (volumePorEstacaoMes[key] || 0) + (r.volume || 0);
    });

    mensal.forEach(function(m) {
      const ano = mesParaAno[m.mes];
      let somaPonderada = 0;
      let somaPesos = 0;

      targetsFiltrados
        .filter(function(t) { return t.station_code !== 'OVERALL' && t.mes === m.mes && t.ref_year === ano; })
        .forEach(function(t) {
          const peso = volumePorEstacaoMes[t.station_code + '-' + m.mes] || 0;
          if (peso > 0 && t.target_loss_rate !== null) {
            somaPonderada += t.target_loss_rate * peso;
            somaPesos += peso;
          }
        });

      m.target_rate = somaPesos > 0 ? somaPonderada / somaPesos : null;
    });
  }

  // Propaga a meta mensal pra cada semana daquele mês (a meta é definida por
  // mês, não por semana - então todas as semanas de um mês compartilham o
  // mesmo valor, formando uma linha "em degraus" no gráfico).
  const targetPorMes = {};
  mensal.forEach(function(m) { targetPorMes[m.mes] = m.target_rate; });
  semanal.forEach(function(s) { s.target_rate = targetPorMes[s.mes] !== undefined ? targetPorMes[s.mes] : null; });

  return { semanal: semanal, mensal: mensal };
}
