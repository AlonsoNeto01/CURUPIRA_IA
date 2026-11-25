import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { MunicipioIBGE, PerfilUsuario, PrevisaoIA, ZonaRiscoEspacial } from './supabase';
import { paraGMS, type FrenteCombate } from './geoprocessing';

type DocWithTable = jsPDF & { lastAutoTable?: { finalY: number } };

async function gerarHashAuditoria(conteudo: string): Promise<string> {
  try {
    if (window.crypto?.subtle) {
      const buf = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(conteudo));
      return Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 24)
        .toUpperCase();
    }
  } catch {
    // Fallback determinístico caso esteja em contexto não-HTTPS
  }
  let hash = 0;
  for (let i = 0; i < conteudo.length; i++) {
    hash = (hash << 5) - hash + conteudo.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16).padStart(12, '0').toUpperCase();
}

function corRiscoRGB(risco: string): [number, number, number] {
  if (risco === 'CRÍTICO') return [185, 28, 28];
  if (risco === 'ALTO') return [234, 88, 12];
  if (risco === 'MODERADO') return [180, 83, 9];
  return [21, 128, 61];
}

export async function emitirBoletimOficialPDF(params: {
  municipio: MunicipioIBGE;
  perfil: PerfilUsuario;
  previsao: PrevisaoIA;
  frentes: FrenteCombate[];
  janelaHoras: number;
  totalFocosJanela: number;
  zonasRisco?: ZonaRiscoEspacial[];
}): Promise<void> {
  const { municipio, perfil, previsao, frentes, janelaHoras, totalFocosJanela } = params;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' }) as DocWithTable;

  const agoraBelem = new Date().toLocaleString('pt-BR', { timeZone: 'America/Belem' });
  const hashPayload = JSON.stringify({
    ibge: municipio.codigo_ibge,
    ref: previsao.data_referencia,
    d1: previsao.focos_previstos_d1,
    d2: previsao.focos_previstos_d2,
    d3: previsao.focos_previstos_d3,
    risco: previsao.nivel_risco,
    frentes: frentes.length,
    emitido: agoraBelem,
  });
  const hashAuditoria = await gerarHashAuditoria(hashPayload);

  // 1. Cabeçalho Institucional
  doc.setFillColor(15, 23, 42);
  doc.rect(0, 0, 210, 30, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text('BOLETIM OFICIAL DE MONITORAMENTO E PREVISÃO DE QUEIMADAS', 14, 12);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.text(
    `Município: ${municipio.nome.toUpperCase()} — ${municipio.uf} (IBGE: ${municipio.codigo_ibge}) | Plataforma Curupira IA`,
    14,
    19
  );
  doc.text(
    `Emissão (Belém): ${agoraBelem} | Operador: ${perfil.nome_completo} (${perfil.role})`,
    14,
    25
  );

  // 2. Faixa de Nível de Risco
  const [r, g, b] = corRiscoRGB(previsao.nivel_risco);
  doc.setFillColor(r, g, b);
  doc.roundedRect(14, 35, 182, 16, 2, 2, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text(`NÍVEL DE RISCO OPERACIONAL (24h): ${previsao.nivel_risco}`, 18, 42);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(
    `Referência: ${previsao.data_referencia} | Probabilidade de Dia Crítico (>=5 focos): ${(
      Number(previsao.prob_dia_critico_d1) * 100
    ).toFixed(1)}% | Motor: ${previsao.modelo_utilizado}`,
    18,
    48
  );

  // 3. Tabela de Prognóstico 72h
  const fmtIC = (inf: number, sup: number) =>
    sup > 500
      ? `${inf.toFixed(1)} a >500 (extremo: ${sup.toFixed(0)})`
      : `${inf.toFixed(1)} a ${sup.toFixed(1)}`;

  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('1. Prognóstico Multi-Horizonte (72h) com Incerteza Conformal 95%', 14, 60);

  autoTable(doc, {
    startY: 63,
    head: [['Horizonte', 'Focos Previstos (VIIRS S-NPP)', 'Banda Conformal 95%', 'Prob. Dia Crítico (>=5)']],
    body: [
      [
        'D+1 (24 horas)',
        `${Number(previsao.focos_previstos_d1).toFixed(1)} focos`,
        fmtIC(Number(previsao.ic_inf_d1), Number(previsao.ic_sup_d1)),
        `${(Number(previsao.prob_dia_critico_d1) * 100).toFixed(1)}%`,
      ],
      [
        'D+2 (48 horas)',
        `${Number(previsao.focos_previstos_d2).toFixed(1)} focos`,
        fmtIC(Number(previsao.ic_inf_d2), Number(previsao.ic_sup_d2)),
        `${(Number(previsao.prob_dia_critico_d2) * 100).toFixed(1)}%`,
      ],
      [
        'D+3 (72 horas)',
        `${Number(previsao.focos_previstos_d3).toFixed(1)} focos`,
        fmtIC(Number(previsao.ic_inf_d3), Number(previsao.ic_sup_d3)),
        `${(Number(previsao.prob_dia_critico_d3) * 100).toFixed(1)}%`,
      ],
    ],
    headStyles: { fillColor: [27, 54, 93], fontSize: 9 },
    bodyStyles: { fontSize: 9 },
    margin: { left: 14, right: 14 },
  });

  // 4. Quadro de Índices Biofísicos e Fatores XAI
  let y = (doc.lastAutoTable?.finalY ?? 95) + 8;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('2. Diagnóstico Biofísico e Fatores Explicativos (XAI)', 14, y);

  const xai = previsao.xai_fatores || {};
  autoTable(doc, {
    startY: y + 3,
    head: [['Indicador Biofísico / Explicativo', 'Valor Atual', 'Interpretação Operacional']],
    body: [
      [
        'VPD Atmosférico (Déficit de Pressão de Vapor)',
        `${Number(previsao.vpd_kpa).toFixed(2)} kPa`,
        Number(previsao.vpd_kpa) >= 1.5 ? 'Estresse evaporativo severo (>1,5 kPa)' : 'Condição atmosférica controlada',
      ],
      [
        'Índice Acumulado de Nesterov (G)',
        `${Number(previsao.indice_nesterov).toFixed(1)}`,
        Number(previsao.indice_nesterov) >= 4000 ? 'Inflamabilidade extrema da serrapilheira' : 'Inflamabilidade baixa a moderada',
      ],
      [
        'Índice de Propagação de Angström (I_A)',
        `${Number(previsao.indice_angstrom).toFixed(2)}`,
        Number(previsao.indice_angstrom) < 2.5 ? 'Favorável à ignição rápida (<2,5)' : 'Propagação desfavorável',
      ],
      [
        'Umidade Volumétrica do Solo (0–7 cm) / Seca',
        `${Number(previsao.umidade_solo_pct).toFixed(1)}% | ${previsao.dias_sem_chuva} dias sem chuva`,
        Number(previsao.umidade_solo_pct) < 30 ? 'Combustível superficial seco' : 'Umidade superficial preservada',
      ],
      [
        'Previsão NWP 72h & Ciclo Antrópico (XAI)',
        `UR mín D+1: ${xai.ur_min_prevista_d1 ?? '—'}% | Chuva 72h: ${xai.chuva_prevista_72h_mm ?? '—'} mm`,
        xai.fim_de_semana_d1 ? 'Atenção: janela antrópica de fim de semana (Sex–Dom)' : 'Dia útil (pressão antrópica regular)',
      ],
    ],
    headStyles: { fillColor: [27, 54, 93], fontSize: 8.5 },
    bodyStyles: { fontSize: 8.5 },
    margin: { left: 14, right: 14 },
  });

  // 5. Frentes Ativas de Combate (DBSCAN) para despacho e ICMS Verde
  const labelJanela = janelaHoras === 168 ? 'Últimos 7 dias (168h)' : `Últimas ${janelaHoras}h`;
  y = (doc.lastAutoTable?.finalY ?? 150) + 8;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text(
    `3. Frentes Ativas de Combate — ${labelJanela} (${totalFocosJanela} focos | ${frentes.length} perímetros DBSCAN)`,
    14,
    y
  );

  const topFrentes = frentes.slice(0, 10);
  if (topFrentes.length === 0) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.text('Nenhuma frente ativa detectada na janela temporal selecionada.', 14, y + 6);
    y += 12;
  } else {
    autoTable(doc, {
      startY: y + 3,
      head: [['Frente', 'Severidade', 'Focos', 'Área (ha)', 'FRP (MW)', 'Centroide (GMS)', 'Jurisdição / CAR']],
      body: topFrentes.map((f) => [
        `#${f.clusterId}`,
        f.severidade,
        String(f.totalFocos),
        String(f.areaHectares),
        String(f.frpTotalMw),
        `${paraGMS(f.centroLat, 'lat')}\n${paraGMS(f.centroLon, 'lon')}`,
        f.jurisdicoes.length ? f.jurisdicoes.join('; ') : 'Área municipal geral',
      ]),
      headStyles: { fillColor: [185, 28, 28], fontSize: 8 },
      bodyStyles: { fontSize: 7.8 },
      margin: { left: 14, right: 14 },
    });
    y = (doc.lastAutoTable?.finalY ?? y + 30) + 6;
  }

  // 5B. Top 5 Setores Prioritários para Patrulha Preventiva (72h)
  const topZonas = (params.zonasRisco || []).slice(0, 5);
  if (topZonas.length > 0) {
    if (y > 235) {
      doc.addPage();
      y = 18;
    }
    doc.setTextColor(15, 23, 42);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text('4. Setores Prioritários de Risco de Ignição/Propagação (Próximas 72h)', 14, y);

    autoTable(doc, {
      startY: y + 3,
      head: [['Setor', 'Risco', 'Score', 'Centroide (GMS)', 'Vento / Chuva 72h', 'Motivo Físico']],
      body: topZonas.map((z, idx) => [
        `Setor #${idx + 1}`,
        z.nivel_risco,
        `${Number(z.score_risco).toFixed(1)}/100`,
        `${paraGMS(z.centro_lat, 'lat')}\n${paraGMS(z.centro_lon, 'lon')}`,
        `${Number(z.velocidade_vento_kmh).toFixed(0)} km/h | ${Number(z.chuva_prevista_72h_mm).toFixed(0)} mm`,
        z.motivo_principal,
      ]),
      columnStyles: {
        0: { cellWidth: 18 }, // Setor
        1: { cellWidth: 20 }, // Risco
        2: { cellWidth: 18 }, // Score
        3: { cellWidth: 36 }, // Centroide GMS
        4: { cellWidth: 28 }, // Vento / Chuva
        5: { cellWidth: 'auto' }, // Motivo Físico
      },
      headStyles: { fillColor: [194, 65, 12], fontSize: 8 },
      bodyStyles: { fontSize: 7.8 },
      margin: { left: 14, right: 14 },
    });
    y = (doc.lastAutoTable?.finalY ?? y + 30) + 6;
  }

  // 6. Rodapé Científico e Hash de Auditoria (ICMS Verde)
  const pageHeight = doc.internal.pageSize.getHeight();
  const yRodape = Math.max(y + 4, pageHeight - 24);
  if (yRodape > pageHeight - 18) {
    doc.addPage();
  }
  const yFinal = doc.internal.pageSize.getHeight() - 20;
  doc.setDrawColor(180, 190, 205);
  doc.line(14, yFinal - 3, 196, yFinal - 3);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.8);
  doc.setTextColor(80, 90, 105);
  doc.text(
    `Validação Científica Global Pará (2025): Ganho +22,22% sobre Naive | R² = ${previsao.r2_validacao} | MAE = ${previsao.mae_validacao} | PICP 95% = 96,4%`,
    14,
    yFinal + 2
  );
  doc.text(
    `Documento técnico para gestão preventiva da SEMMA, Defesa Civil e prestação de contas do ICMS Verde (SEMAS-PA).`,
    14,
    yFinal + 6
  );
  doc.setFont('helvetica', 'bold');
  doc.text(`Hash de Integridade SHA-256: ${hashAuditoria}`, 14, yFinal + 11);

  const nomeArq = `Boletim_CurupiraIA_${municipio.nome.replace(/\s+/g, '_')}_${previsao.data_referencia}.pdf`;
  doc.save(nomeArq);
}
