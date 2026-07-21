// ===================================================================
// ===== ABA ANALÍTICO SOC =====
// ===================================================================
// Análises mais profundas em cima da tabela fwd, pra investigar causa raiz
// das perdas projetadas (não é uma visão de período/tendência como o
// Gerencial - é o retrato ATUAL de tudo que está na fwd agora).
//
// filtroEstacao (usado em todas as funções abaixo):
//   'OVERALL' (ou vazio/undefined) -> todos os SOCs
//   'GROUP:SORTER'/'GROUP:REGI'/'GROUP:REGII' -> só os SOCs daquele grupo
//   um código específico (ex: 'SP2') -> só aquele SOC

// ===== Resolve o filtro selecionado numa lista de station_code (com prefixo
// SOC-), pronta pra usar num "IN (...)" de SQL. Retorna null = sem filtro
// (todos os SOCs).
function resolverListaFiltroSQL_(filtroEstacao) {
  let lista = null;

  if (filtroEstacao === 'GROUP:SORTER') {
    lista = SORTER_STATIONS;
  } else if (filtroEstacao === 'GROUP:REGI') {
    lista = obterListaEstacoesAgrupadas().regI;
  } else if (filtroEstacao === 'GROUP:REGII') {
    lista = obterListaEstacoesAgrupadas().regII;
  } else if (filtroEstacao && filtroEstacao !== 'OVERALL') {
    lista = [filtroEstacao];
  }

  if (!lista) return null;

  return lista.map(function(codigo) { return `'SOC-${codigo}'`; }).join(',');
}

// Monta a condição SQL de filtro de estação pronta pra colar num WHERE
// (sempre começa com "AND ").
function condicaoFiltroEstacao_(filtroEstacao) {
  const listaSQL = resolverListaFiltroSQL_(filtroEstacao);
  return listaSQL ? `AND station_code IN (${listaSQL})` : '';
}

// Converte pra Number de forma defensiva - protege contra o BigQuery
// devolvendo valores como string (o que quebraria += virando concatenação
// de texto em vez de soma).
function paraNumero_(valor) {
  const n = Number(valor);
  return isNaN(n) ? 0 : n;
}

// ===== Distribuição de remessas por status (macro_status + last_status) =====
// Chamada pelo front-end via google.script.run.obterDistribuicaoStatus(filtroEstacao).
function obterDistribuicaoStatus(filtroEstacao) {
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

// ===== Recuperação necessária, detalhada MÊS A MÊS =====
// Em vez de juntar tudo num número só, calcula pra CADA mês presente na
// fwd e/ou na losses:
//   - total projetado do mês = losses REALIZADOS (já aconteceram) + forecast
//     (COUNT DISTINCT shipment_id da fwd, baseado em data_base_loss) -
//     precisa somar os dois pra saber se o mês vai fechar dentro do target
//   - o teto permitido daquele mês (target × volume daquele mês)
//   - quantos pacotes precisam ser recuperados NAQUELE mês especificamente
// Usa EXTRACT(YEAR FROM ...) direto nas datas (em vez de assumir o ano a
// partir da data de hoje), então funciona corretamente mesmo se os dados
// cobrirem meses de anos diferentes.
// Totalmente independente do Gerencial.gs - consultas próprias.
// Chamada pelo front-end via google.script.run.obterRecuperacaoNecessaria(filtroEstacao).
function obterRecuperacaoNecessaria(filtroEstacao) {
  const condicao = condicaoFiltroEstacao_(filtroEstacao);
  const overall = !filtroEstacao || filtroEstacao === 'OVERALL';

  // ===== Forecast por (ano, mês, semana) - sem restringir período. =====
  const queryForecast = `
    SELECT
      EXTRACT(YEAR FROM data_base_loss) AS ano,
      mes,
      semana,
      COUNT(DISTINCT shipment_id) AS qtd_remessas
    FROM \`${BQ_CONFIG.PROJECT_ID}.${BQ_CONFIG.DATASET_ID}.inventory_forecast_losses_fwd\`
    WHERE station_code LIKE 'SOC-%'
      ${condicao}
    GROUP BY ano, mes, semana
    ORDER BY ano, mes, semana
  `;
  const forecastPorSemana = executarQuery_(queryForecast);
  forecastPorSemana.forEach(function(f) {
    f.qtd_remessas = paraNumero_(f.qtd_remessas);
    f.mes = paraNumero_(f.mes);
    f.ano = paraNumero_(f.ano);
    f.semana = paraNumero_(f.semana);
  });

  // ===== Losses REALIZADOS por (ano, mês, semana). =====
  const queryLosses = `
    SELECT
      EXTRACT(YEAR FROM data_base_loss) AS ano,
      mes,
      semana,
      SUM(losses) AS losses
    FROM \`${BQ_CONFIG.PROJECT_ID}.${BQ_CONFIG.DATASET_ID}.inventory_forecast_losses_losses\`
    WHERE station_code LIKE 'SOC-%'
      ${condicao}
    GROUP BY ano, mes, semana
  `;
  const lossesPorSemana = executarQuery_(queryLosses);
  lossesPorSemana.forEach(function(l) {
    l.losses = paraNumero_(l.losses);
    l.mes = paraNumero_(l.mes);
    l.ano = paraNumero_(l.ano);
    l.semana = paraNumero_(l.semana);
  });

  if (forecastPorSemana.length === 0 && lossesPorSemana.length === 0) {
    return { temDados: false };
  }

  // Une as semanas que aparecem no forecast E/OU nos losses realizados.
  const chavesSemana = {};
  forecastPorSemana.forEach(function(f) {
    chavesSemana[f.ano + '-' + f.mes + '-' + f.semana] = { ano: f.ano, mes: f.mes, semana: f.semana };
  });
  lossesPorSemana.forEach(function(l) {
    chavesSemana[l.ano + '-' + l.mes + '-' + l.semana] = { ano: l.ano, mes: l.mes, semana: l.semana };
  });
  const semanasUnicas = Object.keys(chavesSemana).map(function(k) { return chavesSemana[k]; });

  const chavesMes = {};
  semanasUnicas.forEach(function(s) { chavesMes[s.ano + '-' + s.mes] = { ano: s.ano, mes: s.mes }; });
  const mesesUnicos = Object.keys(chavesMes).map(function(k) { return chavesMes[k]; });

  // ===== Volume por (ano, mês, semana, estação) - só das semanas em uso. =====
  const queryVolume = `
    SELECT
      REPLACE(station_code, 'SOC-', '') AS station_code,
      EXTRACT(YEAR FROM dia) AS ano,
      mes,
      semana,
      SUM(volume) AS volume
    FROM \`${BQ_CONFIG.PROJECT_ID}.${BQ_CONFIG.DATASET_ID}.inventory_forecast_losses_volume\`
    WHERE station_code LIKE 'SOC-%'
      ${condicao}
    GROUP BY station_code, ano, mes, semana
  `;
  const volumeRows = executarQuery_(queryVolume);
  volumeRows.forEach(function(v) {
    v.volume = paraNumero_(v.volume);
    v.mes = paraNumero_(v.mes);
    v.ano = paraNumero_(v.ano);
    v.semana = paraNumero_(v.semana);
  });

  // ===== Targets - só dos meses em uso (a meta é mensal, vale pra todas as
  // semanas daquele mês). =====
  const condicoesMes = mesesUnicos
    .map(function(m) { return `(ref_month = ${m.mes} AND ref_year = ${m.ano})`; })
    .join(' OR ');

  const queryTargets = `
    SELECT
      REPLACE(station_code, 'SOC-', '') AS station_code,
      ref_year,
      ref_month AS mes,
      target_loss_rate
    FROM \`${BQ_CONFIG.PROJECT_ID}.${BQ_CONFIG.DATASET_ID}.inventory_forecast_losses_targets\`
    WHERE ${condicoesMes}
  `;
  const targetsRows = executarQuery_(queryTargets);
  targetsRows.forEach(function(t) {
    t.target_loss_rate = paraNumero_(t.target_loss_rate);
    t.ref_year = paraNumero_(t.ref_year);
    t.mes = paraNumero_(t.mes);
  });

  // ===== Calcula teto (target × volume) pra uma "fatia" qualquer (mês
  // inteiro OU uma semana específica), reaproveitando a mesma lógica de
  // Overall/grupo/SOC específico. =====
  function calcularTeto_(ano, mes, filtroVolume) {
    if (overall) {
      const linhaOverall = targetsRows.filter(function(t) {
        return t.station_code === 'OVERALL' && t.mes === mes && t.ref_year === ano;
      })[0];
      const volumeTotal = filtroVolume.reduce(function(acc, v) { return acc + v.volume; }, 0);

      return (linhaOverall && volumeTotal > 0) ? linhaOverall.target_loss_rate * volumeTotal : null;
    }

    let somaTeto = 0;
    let temTarget = false;

    filtroVolume.forEach(function(v) {
      const targetEstacao = targetsRows.filter(function(t) {
        return t.station_code === v.station_code && t.mes === mes && t.ref_year === ano;
      })[0];
      if (targetEstacao) {
        somaTeto += targetEstacao.target_loss_rate * v.volume;
        temTarget = true;
      }
    });

    return temTarget ? somaTeto : null;
  }

  // Monta o objeto de resultado (comum a mês e a semana).
  function montarResultado_(totalProjetado, forecastDaFatia, teto) {
    const excedente = teto !== null ? (totalProjetado - teto) : null;
    const pacotesARecuperar = (excedente !== null && excedente > 0)
      ? Math.min(forecastDaFatia, Math.ceil(excedente))
      : 0;
    const insalvavel = excedente !== null && excedente > forecastDaFatia;

    return {
      temTarget: teto !== null,
      teto: teto !== null ? Math.round(teto) : null,
      pacotesARecuperar: pacotesARecuperar,
      dentroDoTarget: teto !== null ? excedente <= 0 : null,
      insalvavel: insalvavel
    };
  }

  // ===== Monta o detalhamento mês a mês, com as semanas aninhadas =====
  const porMes = mesesUnicos.map(function(chaveMes) {
    const lossesDoMes = lossesPorSemana
      .filter(function(l) { return l.mes === chaveMes.mes && l.ano === chaveMes.ano; })
      .reduce(function(acc, l) { return acc + l.losses; }, 0);

    const forecastDoMes = forecastPorSemana
      .filter(function(f) { return f.mes === chaveMes.mes && f.ano === chaveMes.ano; })
      .reduce(function(acc, f) { return acc + f.qtd_remessas; }, 0);

    const totalProjetadoMes = lossesDoMes + forecastDoMes;
    const tetoMes = calcularTeto_(
      chaveMes.ano,
      chaveMes.mes,
      volumeRows.filter(function(v) { return v.mes === chaveMes.mes && v.ano === chaveMes.ano; })
    );
    const resultadoMes = montarResultado_(totalProjetadoMes, forecastDoMes, tetoMes);

    // Semanas desse mês, ordenadas.
    const semanasDoMes = semanasUnicas
      .filter(function(s) { return s.mes === chaveMes.mes && s.ano === chaveMes.ano; })
      .sort(function(a, b) { return a.semana - b.semana; })
      .map(function(chaveSemana) {
        const lossesDaSemana = lossesPorSemana
          .filter(function(l) { return l.mes === chaveSemana.mes && l.ano === chaveSemana.ano && l.semana === chaveSemana.semana; })
          .reduce(function(acc, l) { return acc + l.losses; }, 0);

        const forecastDaSemana = forecastPorSemana
          .filter(function(f) { return f.mes === chaveSemana.mes && f.ano === chaveSemana.ano && f.semana === chaveSemana.semana; })
          .reduce(function(acc, f) { return acc + f.qtd_remessas; }, 0);

        const totalProjetadoSemana = lossesDaSemana + forecastDaSemana;
        const tetoSemana = calcularTeto_(
          chaveSemana.ano,
          chaveSemana.mes,
          volumeRows.filter(function(v) {
            return v.mes === chaveSemana.mes && v.ano === chaveSemana.ano && v.semana === chaveSemana.semana;
          })
        );
        const resultadoSemana = montarResultado_(totalProjetadoSemana, forecastDaSemana, tetoSemana);

        return Object.assign({
          semana: chaveSemana.semana,
          lossesRealizados: lossesDaSemana,
          forecast: forecastDaSemana,
          totalProjetado: totalProjetadoSemana
        }, resultadoSemana);
      });

    return Object.assign({
      ano: chaveMes.ano,
      mes: chaveMes.mes,
      lossesRealizados: lossesDoMes,
      forecast: forecastDoMes,
      totalProjetado: totalProjetadoMes,
      semanas: semanasDoMes
    }, resultadoMes);
  }).sort(function(a, b) { return (a.ano - b.ano) || (a.mes - b.mes); });

  return {
    temDados: true,
    porMes: porMes,
    // ARecuperar geral = soma do que falta recuperar em CADA mês
    // individualmente (não é uma conta líquida entre meses - um mês com
    // sobra não compensa outro com déficit). Meses insalváveis (onde nem
    // recuperar 100% do forecast resolve) ficam de FORA dessa soma - contar
    // esses pacotes não ajuda a atingir nenhum target, então inflaria o
    // número sem necessidade.
    totalGeralProjetado: porMes.reduce(function(acc, m) { return acc + m.totalProjetado; }, 0),
    totalGeralARecuperar: porMes.reduce(function(acc, m) {
      return m.insalvavel ? acc : acc + m.pacotesARecuperar;
    }, 0)
  };
}

// ===== Distribuição por aging_by_loss (dias até a perda ser registrada) =====
// aging_by_loss = 0 significa que a perda é registrada HOJE (máxima urgência).
// Quanto maior o valor, mais tempo ainda resta pra recuperar a remessa antes
// dela virar perda de fato.
// Chamada pelo front-end via google.script.run.obterDistribuicaoAging(filtroEstacao).
function obterDistribuicaoAging(filtroEstacao) {
  const query = `
    SELECT
      aging_by_loss,
      COUNT(DISTINCT shipment_id) AS qtd_remessas
    FROM \`${BQ_CONFIG.PROJECT_ID}.${BQ_CONFIG.DATASET_ID}.inventory_forecast_losses_fwd\`
    WHERE station_code LIKE 'SOC-%'
      AND aging_by_loss IS NOT NULL
      ${condicaoFiltroEstacao_(filtroEstacao)}
    GROUP BY aging_by_loss
    ORDER BY aging_by_loss ASC
  `;

  const linhas = executarQuery_(query);
  linhas.forEach(function(l) {
    l.qtd_remessas = paraNumero_(l.qtd_remessas);
    l.aging_by_loss = paraNumero_(l.aging_by_loss);
  });

  const total = linhas.reduce(function(acc, l) { return acc + l.qtd_remessas; }, 0);

  let acumulado = 0;
  linhas.forEach(function(l) {
    acumulado += l.qtd_remessas;
    l.percentual = total > 0 ? l.qtd_remessas / total : 0;
    l.acumulado = acumulado;
    l.percentualAcumulado = total > 0 ? acumulado / total : 0;
  });

  // Resumo rápido pra KPIs de urgência.
  function somarAte(diasMax) {
    return linhas
      .filter(function(l) { return l.aging_by_loss <= diasMax; })
      .reduce(function(acc, l) { return acc + l.qtd_remessas; }, 0);
  }

  const resumo = {
    hoje: somarAte(0),
    ateAmanha: somarAte(1),
    ate3Dias: somarAte(3),
    ate7Dias: somarAte(7)
  };

  const tetoInfo = obterTetoRestanteMesAtual_(filtroEstacao);

  return {
    total: total,
    linhas: linhas,
    resumo: resumo,
    tetoRestante: tetoInfo.temTeto ? tetoInfo.tetoRestante : null
  };
}

// ===== Teto restante do MÊS ATUAL (target × volume do mês, menos o que já
// foi perdido/realizado) - usado como linha de referência no gráfico de aging,
// pra mostrar quanto ainda "cabe" antes de estourar a meta do mês corrente.
function obterTetoRestanteMesAtual_(filtroEstacao) {
  const hoje = new Date();
  const anoAtual = hoje.getFullYear();
  const mesAtual = hoje.getMonth() + 1;
  const condicao = condicaoFiltroEstacao_(filtroEstacao);
  const overall = !filtroEstacao || filtroEstacao === 'OVERALL';

  const queryVolume = `
    SELECT REPLACE(station_code, 'SOC-', '') AS station_code, SUM(volume) AS volume
    FROM \`${BQ_CONFIG.PROJECT_ID}.${BQ_CONFIG.DATASET_ID}.inventory_forecast_losses_volume\`
    WHERE EXTRACT(YEAR FROM dia) = ${anoAtual} AND mes = ${mesAtual}
      AND station_code LIKE 'SOC-%'
      ${condicao}
    GROUP BY station_code
  `;
  const volumeRows = executarQuery_(queryVolume);
  volumeRows.forEach(function(v) { v.volume = paraNumero_(v.volume); });

  const queryLosses = `
    SELECT SUM(losses) AS losses
    FROM \`${BQ_CONFIG.PROJECT_ID}.${BQ_CONFIG.DATASET_ID}.inventory_forecast_losses_losses\`
    WHERE EXTRACT(YEAR FROM data_base_loss) = ${anoAtual} AND mes = ${mesAtual}
      AND station_code LIKE 'SOC-%'
      ${condicao}
  `;
  const lossesRows = executarQuery_(queryLosses);
  const lossesRealizados = lossesRows.length > 0 ? paraNumero_(lossesRows[0].losses) : 0;

  const queryTargets = `
    SELECT REPLACE(station_code, 'SOC-', '') AS station_code, target_loss_rate
    FROM \`${BQ_CONFIG.PROJECT_ID}.${BQ_CONFIG.DATASET_ID}.inventory_forecast_losses_targets\`
    WHERE ref_month = ${mesAtual} AND ref_year = ${anoAtual}
  `;
  const targetsRows = executarQuery_(queryTargets);
  targetsRows.forEach(function(t) { t.target_loss_rate = paraNumero_(t.target_loss_rate); });

  let teto = null;

  if (overall) {
    const linhaOverall = targetsRows.filter(function(t) { return t.station_code === 'OVERALL'; })[0];
    const volumeTotal = volumeRows.reduce(function(acc, v) { return acc + v.volume; }, 0);
    if (linhaOverall && volumeTotal > 0) {
      teto = linhaOverall.target_loss_rate * volumeTotal;
    }
  } else {
    let somaTeto = 0;
    let temTarget = false;
    volumeRows.forEach(function(v) {
      const targetEstacao = targetsRows.filter(function(t) { return t.station_code === v.station_code; })[0];
      if (targetEstacao) {
        somaTeto += targetEstacao.target_loss_rate * v.volume;
        temTarget = true;
      }
    });
    if (temTarget) teto = somaTeto;
  }

  if (teto === null) return { temTeto: false };

  return {
    temTeto: true,
    teto: Math.round(teto),
    lossesRealizados: lossesRealizados,
    tetoRestante: Math.max(0, Math.round(teto - lossesRealizados))
  };
}
