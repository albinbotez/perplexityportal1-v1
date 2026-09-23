// ============================================================
// SÆRAVGIFTSMELDING — filopplasting til Skatteetaten
//
// Ren logikk uten DOM/Supabase, slik at den kan enhetstestes i Node
// (`node --test`) og brukes direkte i nettleseren (window.Saeravgift).
//
// Filformat (Skatteetaten «Last opp fil»), semikolon, ingen overskrift:
//   O;<orgnr>;
//   L;<linjenr>;<avgiftstype>;<avgiftsgruppe>;<tilleggskode>;<periode>;<antall>;<antall2>;<satsår>;
// ============================================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Saeravgift = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BOTTLE_LITERS = 0.75;

  // ----------------------------------------------------------
  // Konfigurerbar tabell: vare -> avgiftsgruppe
  //   varetype:   produkttype i portalen som gruppen gjelder for
  //   minPct:     nedre grense, eksklusiv (> minPct)
  //   maxPct:     øvre grense, inklusiv (<= maxPct)
  //   perVolPct:  true = sats per liter per volumprosent (antall2 = styrke)
  //               false = sats per liter (antall2 tom)
  //   sats:       kr (per liter, eller per liter per vol%) — kun for
  //               forhåndsvisning. null for 515–517 = bruk vin-satsen
  //               fra Innstillinger; null for øvrige = ukjent sats.
  // ----------------------------------------------------------
  const DEFAULT_GROUPS = [
    { avgiftstype: 'BV', avgiftsgruppe: '512', varetype: 'vin', minPct: 0.7, maxPct: 2.7, perVolPct: false, sats: null, beskrivelse: 'Vin >0,7–2,7 %' },
    { avgiftstype: 'BV', avgiftsgruppe: '513', varetype: 'vin', minPct: 2.7, maxPct: 3.7, perVolPct: false, sats: null, beskrivelse: 'Vin >2,7–3,7 %' },
    { avgiftstype: 'BV', avgiftsgruppe: '514', varetype: 'vin', minPct: 3.7, maxPct: 4.7, perVolPct: false, sats: null, beskrivelse: 'Vin >3,7–4,7 %' },
    { avgiftstype: 'BV', avgiftsgruppe: '515', varetype: 'vin', minPct: 4.7, maxPct: 10,  perVolPct: true,  sats: null, beskrivelse: 'Vin >4,7–10 %' },
    { avgiftstype: 'BV', avgiftsgruppe: '516', varetype: 'vin', minPct: 10,  maxPct: 15,  perVolPct: true,  sats: null, beskrivelse: 'Vin >10–15 %' },
    { avgiftstype: 'BV', avgiftsgruppe: '517', varetype: 'vin', minPct: 15,  maxPct: 22,  perVolPct: true,  sats: null, beskrivelse: 'Vin >15–22 %' }
  ];

  // ----------------------------------------------------------
  // Konfigurerbar tabell: bevegelsestype -> tilleggskode
  //   kode:          '' = ordinær avgift, ellers to siffer
  //   lagerRetning:  -1 = ut av lager, +1 = tilbake på lager
  //   avgiftFortegn: kun forhåndsvisning — +1 avgift, 0 avgiftsfritt,
  //                  -1 fradrag (tilbakeført avgift)
  //   krevPeriode:   true = opprinnelig uttaksperiode må oppgis
  // ----------------------------------------------------------
  const DEFAULT_MOVEMENT_CODES = [
    { type: 'salg',             label: 'Salg/uttak fra lager',                           kode: '',   lagerRetning: -1, avgiftFortegn:  1, krevPeriode: false },
    { type: 'eksport',          label: 'Eksport',                                        kode: '20', lagerRetning: -1, avgiftFortegn:  0, krevPeriode: false },
    { type: 'overfort',         label: 'Overført til annen registrert avgiftspliktig',   kode: '30', lagerRetning: -1, avgiftFortegn:  0, krevPeriode: false },
    { type: 'tilintetgjort',    label: 'Tilintetgjort',                                  kode: '40', lagerRetning: -1, avgiftFortegn:  0, krevPeriode: false },
    { type: 'retur',            label: 'Retur',                                          kode: '50', lagerRetning:  1, avgiftFortegn: -1, krevPeriode: true  },
    { type: 'retur_avgiftsfri', label: 'Retur av vare levert avgiftsfritt',              kode: '51', lagerRetning:  1, avgiftFortegn:  0, krevPeriode: false },
    { type: 'manko',            label: 'Manko',                                          kode: '99', lagerRetning: -1, avgiftFortegn:  1, krevPeriode: false }
  ];

  function defaultConfig() {
    return {
      orgnr: '',
      groups: DEFAULT_GROUPS.map(g => ({ ...g })),
      movementCodes: DEFAULT_MOVEMENT_CODES.map(c => ({ ...c }))
    };
  }

  // ----------------------------------------------------------
  // Hjelpere
  // ----------------------------------------------------------
  class SaeravgiftError extends Error {
    constructor(errors) {
      super(errors.join('\n'));
      this.name = 'SaeravgiftError';
      this.errors = errors;
    }
  }

  // Organisasjonsnummer: 9 siffer med MOD11-kontrollsiffer
  function isValidOrgnr(orgnr) {
    const s = String(orgnr || '').replace(/\s/g, '');
    if (!/^\d{9}$/.test(s)) return false;
    const w = [3, 2, 7, 6, 5, 4, 3, 2];
    const sum = w.reduce((acc, wi, i) => acc + wi * Number(s[i]), 0);
    let k = 11 - (sum % 11);
    if (k === 11) k = 0;
    if (k === 10) return false;
    return k === Number(s[8]);
  }

  // 'yyyy-mm' / 'yyyy-mm-dd' / 'yyyy/mm' -> 'yyyy/mm'
  function toPeriode(value) {
    const m = /^(\d{4})[-/](\d{2})/.exec(String(value || ''));
    return m ? `${m[1]}/${m[2]}` : null;
  }

  // Tall med maks n desimaler, punktum, ingen tusenskille, ingen etterfølgende nuller
  function fmtNumber(value, decimals) {
    const f = Math.pow(10, decimals);
    const rounded = Math.round((value + Number.EPSILON * Math.sign(value)) * f) / f;
    let s = rounded.toFixed(decimals);
    if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s === '-0' ? '0' : s;
  }

  function findGroup(config, product) {
    const pct = Number(product.alcohol_pct);
    return config.groups.find(g =>
      (!g.varetype || g.varetype === product.type) && pct > g.minPct && pct <= g.maxPct
    ) || null;
  }

  function findMovementCode(config, type) {
    return config.movementCodes.find(c => c.type === (type || 'salg')) || null;
  }

  // Liter med fortegn. Korreksjonsrader (reversering) har negativt antall.
  function movementLiters(m) {
    if (m.liters != null) return Number(m.liters);
    return Number(m.bottles) * BOTTLE_LITERS;
  }

  function isCorrection(m) {
    return m.corrects_id != null && m.corrects_id !== '';
  }

  // ----------------------------------------------------------
  // Klassifiser og valider alle bevegelser i perioden.
  //   movements: [{ id, date:'yyyy-mm-dd', type, bottles|liters,
  //                 original_period, document_ref, corrects_id,
  //                 product:{name,type,alcohol_pct}, customer }]
  //   period:    'yyyy-mm'
  // Kaster SaeravgiftError med alle feil samlet — ingen fil lages da.
  // ----------------------------------------------------------
  function classify(movements, period, config) {
    const errors = [];
    const periode = toPeriode(period);
    if (!periode) errors.push(`Ugyldig periode «${period}» (forventet yyyy-mm).`);
    if (!config.orgnr) errors.push('Organisasjonsnummer mangler. Legg det inn under Innstillinger.');
    else if (!isValidOrgnr(config.orgnr)) errors.push(`Organisasjonsnummer «${config.orgnr}» er ugyldig (9 siffer med gyldig kontrollsiffer).`);

    const classified = [];
    (movements || []).forEach(m => {
      const p = m.product;
      const name = p && p.name ? `«${p.name}»` : '(ukjent vare)';
      const when = m.date ? ` (${m.date})` : '';
      if (!p) { errors.push(`Bevegelse${when} mangler vare.`); return; }

      const pct = p.alcohol_pct;
      if (pct === null || pct === undefined || pct === '' || !(Number(pct) > 0)) {
        errors.push(`Varen ${name} mangler styrke (alkohol %).`);
        return;
      }
      const group = findGroup(config, p);
      if (!group) {
        errors.push(`Varen ${name} (${p.type || 'ukjent type'}, ${pct} %) passer ikke i noen avgiftsgruppe.`);
        return;
      }
      const code = findMovementCode(config, m.type);
      if (!code) {
        errors.push(`Bevegelse${when} for ${name} har ukjent bevegelsestype «${m.type}».`);
        return;
      }
      const liters = movementLiters(m);
      const correction = isCorrection(m);
      if (!Number.isFinite(liters) || liters === 0 || (liters < 0) !== correction) {
        errors.push(correction
          ? `Korreksjonsrad${when} for ${name} må ha negativt antall.`
          : `Bevegelse${when} for ${name} har ugyldig antall (negativt antall er kun lov på korreksjonsrader).`);
        return;
      }

      let linjePeriode = periode;
      if (code.krevPeriode) {
        linjePeriode = toPeriode(m.original_period);
        if (!linjePeriode) {
          errors.push(`${code.label}${when} av ${name} mangler opprinnelig uttaksperiode (tilleggskode ${code.kode}).`);
          return;
        }
      }

      classified.push({
        movement: m,
        product: p,
        group,
        code,
        liters,
        correction,
        styrke: Math.round(Number(pct) * 10) / 10,
        periode: linjePeriode
      });
    });

    if (errors.length) throw new SaeravgiftError(errors);
    return classified;
  }

  // ----------------------------------------------------------
  // Aggreger på (avgiftstype, avgiftsgruppe, styrke, tilleggskode, periode)
  // Avgiftsfrie bevegelser får egne linjer — nettoføres aldri.
  // Korreksjonsrader har samme nøkkel som bevegelsen de reverserer og
  // opphever den; linjer som blir 0 liter tas ikke med i filen.
  // ----------------------------------------------------------
  function aggregate(classified) {
    const map = new Map();
    classified.forEach(c => {
      const styrkeKey = c.group.perVolPct ? fmtNumber(c.styrke, 1) : '';
      const key = [c.group.avgiftstype, c.group.avgiftsgruppe, styrkeKey, c.code.kode, c.periode].join('|');
      if (!map.has(key)) {
        map.set(key, {
          avgiftstype: c.group.avgiftstype,
          avgiftsgruppe: c.group.avgiftsgruppe,
          tilleggskode: c.code.kode,
          periode: c.periode,
          styrke: c.group.perVolPct ? c.styrke : null,
          group: c.group,
          code: c.code,
          liters: 0,
          movements: []
        });
      }
      const line = map.get(key);
      line.liters += c.liters;
      line.movements.push(c);
    });

    const errors = [];
    const lines = [];
    [...map.values()].forEach(l => {
      l.liters = Number(fmtNumber(l.liters, 4));
      l.movements.forEach(c => { c.linjenr = null; });
      if (l.liters < 0) {
        errors.push(`Negativt antall (${fmtNumber(l.liters, 4)} l) for ${l.avgiftstype} ${l.avgiftsgruppe}` +
          `${l.tilleggskode ? ` kode ${l.tilleggskode}` : ''} ${l.periode} — korreksjon uten tilhørende bevegelse.`);
      } else if (l.liters > 0) {
        lines.push(l);
      }
    });
    if (errors.length) throw new SaeravgiftError(errors);

    lines.sort((a, b) =>
      a.avgiftstype.localeCompare(b.avgiftstype) ||
      a.avgiftsgruppe.localeCompare(b.avgiftsgruppe) ||
      a.tilleggskode.localeCompare(b.tilleggskode) ||
      a.periode.localeCompare(b.periode) ||
      (a.styrke || 0) - (b.styrke || 0)
    );
    lines.forEach((l, i) => {
      l.linjenr = i + 1;
      l.movements.forEach(c => { c.linjenr = l.linjenr; });
    });
    return lines;
  }

  // ----------------------------------------------------------
  // CSV-fil (UTF-8 uten BOM, CRLF). Hver L-linje har ALLTID hele malen
  // med 9 felt og 9 semikolon; antall2 og satsår står tomme når de ikke
  // er aktuelle for gruppen.
  // ----------------------------------------------------------
  function buildCsvLine(l) {
    return [
      'L',
      l.linjenr,
      l.avgiftstype,
      l.avgiftsgruppe,
      l.tilleggskode,
      l.periode,
      fmtNumber(l.liters, 4),
      l.styrke != null ? fmtNumber(l.styrke, 1) : '',
      l.satsaar || ''
    ].join(';') + ';';
  }

  function buildCsv(orgnr, lines) {
    const out = [`O;${String(orgnr).replace(/\s/g, '')};`];
    lines.forEach(l => out.push(buildCsvLine(l)));
    return out.join('\r\n');
  }

  function fileName(orgnr, period, ext) {
    return `saeravgift_${String(orgnr).replace(/\s/g, '')}_${period}.${ext}`;
  }

  // ----------------------------------------------------------
  // Estimert avgift — kun for visning. Skatteetaten beregner endelig beløp.
  //   515–517: liter × styrke × sats     512–514: liter × sats
  // Beløp per bevegelse regnes i hele øre med gulv-avrunding (også for
  // negative beløp: −97,375 → −97,38). Korreksjonsrader speiler beløpet
  // til bevegelsen de reverserer, så de opphever hverandre eksakt.
  // ----------------------------------------------------------
  function resolveSats(group, rates) {
    if (group.sats != null && group.sats !== '') return Number(group.sats);
    if (group.perVolPct && rates && rates.vin != null) return Number(rates.vin);
    return null;
  }

  function movementAmountOre(c, sats) {
    if (c.code.avgiftFortegn === 0) return 0;
    if (sats == null) return null;
    // Heltallsregning: liter i 1/10000, styrke i 1/10, sats i øre
    const l4 = Math.round(Math.abs(c.liters) * 10000);
    const ore = Math.round(sats * 100);
    const num = c.group.perVolPct ? l4 * Math.round(c.styrke * 10) * ore : l4 * ore;
    const den = c.group.perVolPct ? 100000 : 10000;
    const signed = c.code.avgiftFortegn > 0 ? Math.floor(num / den) : Math.floor(-num / den);
    return c.liters < 0 ? -signed : signed;
  }

  // ----------------------------------------------------------
  // Spesifikasjon (dokumentasjon, lastes IKKE opp): én rad per bevegelse,
  // inkludert korreksjonsrader og bevegelser som er korrigert bort.
  // ----------------------------------------------------------
  function specification(classified, rates) {
    return classified.map(c => {
      const m = c.movement;
      const sats = resolveSats(c.group, rates);
      const ore = movementAmountOre(c, sats);
      return {
        linjenr: c.linjenr,
        ore,
        row: {
          'Linjenr i fil': c.linjenr == null ? '' : c.linjenr,
          'Dato': m.date || '',
          'Bevegelsestype': c.code.label,
          'Dokumentreferanse': m.document_ref || '',
          'Vare': c.product.name || '',
          'Produsent': c.product.producer || '',
          'Kunde': (m.customer && m.customer.name) || '',
          'Flasker': m.bottles != null ? Number(m.bottles) : '',
          'Liter': Number(fmtNumber(c.liters, 4)),
          'Styrke %': Number(c.product.alcohol_pct),
          'Avgiftstype': c.group.avgiftstype,
          'Avgiftsgruppe': c.group.avgiftsgruppe,
          'Tilleggskode': c.code.kode,
          'Periode': c.periode,
          'Opprinnelig uttaksperiode': m.original_period ? toPeriode(m.original_period) : '',
          'Korrigerer bevegelse': m.corrects_id || '',
          'Registrert': m.recorded_at || '',
          'Bevegelses-ID': m.id || '',
          'Sats': sats == null ? '' : sats,
          'Estimert avgift (kr)': ore == null ? '' : ore / 100,
          'Notat': m.notes || ''
        }
      };
    });
  }

  // Forhåndsvisning bygges KUN fra spesifikasjonsradene: linjebeløp og
  // totalsum er summen av radene bak dem, aldri regnet separat.
  function preview(lines, spec) {
    const missingSats = new Set();
    const rows = lines.map(l => {
      const entries = spec.filter(e => e.linjenr === l.linjenr);
      const missing = entries.some(e => e.ore == null);
      if (missing) missingSats.add(l.avgiftsgruppe);
      const lineOre = entries.reduce((a, e) => a + (e.ore || 0), 0);
      const sats = entries.length && entries[0].row['Sats'] !== '' ? entries[0].row['Sats'] : null;
      return { ...l, sats, avgift: missing ? null : lineOre / 100 };
    });
    const totalOre = spec.reduce((a, e) => a + (e.ore || 0), 0);
    return {
      rows,
      totalOre,
      total: totalOre / 100,
      totalAvrundet: Math.floor(totalOre / 100), // gulv, også for negative summer
      missingSats: [...missingSats]
    };
  }

  // ----------------------------------------------------------
  // Hovedfunksjon: alt som trengs for eksport og visning.
  // Hele periodens innhold tas alltid med — også ved endringsmelding.
  // ----------------------------------------------------------
  function buildExport(movements, period, config, rates) {
    const classified = classify(movements, period, config);
    if (!classified.length) throw new SaeravgiftError([`Ingen lagerbevegelser i ${period}.`]);
    const lines = aggregate(classified);
    if (!lines.length) throw new SaeravgiftError([`Alle bevegelser i ${period} er korrigert bort — ingen linjer å rapportere.`]);
    const orgnr = String(config.orgnr).replace(/\s/g, '');
    const spec = specification(classified, rates);
    return {
      orgnr,
      period,
      lines,
      csv: buildCsv(orgnr, lines),
      csvFileName: fileName(orgnr, period, 'csv'),
      specFileName: `saeravgift_spesifikasjon_${orgnr}_${period}.xlsx`,
      preview: preview(lines, spec),
      specification: spec.map(e => e.row)
    };
  }

  // ----------------------------------------------------------
  // Tilleggskode-tabellen: validering av (utvidbar) konfigurasjon.
  // Nye bevegelsestyper/koder legges til som data, uten kodeendring.
  // ----------------------------------------------------------
  function validateMovementCodes(codes) {
    const errors = [];
    const seen = new Set();
    (codes || []).forEach(c => {
      const t = c.type || '';
      if (!/^[a-z0-9_]+$/.test(t)) errors.push(`Bevegelsestype «${t}» må bestå av små bokstaver, tall og _.`);
      else if (seen.has(t)) errors.push(`Bevegelsestype «${t}» finnes flere ganger.`);
      seen.add(t);
      if (!String(c.label || '').trim()) errors.push(`Bevegelsestype «${t}» mangler navn.`);
      if (c.kode && !/^\d{2}$/.test(c.kode)) errors.push(`Tilleggskode for «${c.label || t}» må være to siffer eller tom.`);
      if (c.lagerRetning !== 1 && c.lagerRetning !== -1) errors.push(`Lagerretning for «${c.label || t}» må være inn eller ut.`);
      if (![1, 0, -1].includes(c.avgiftFortegn)) errors.push(`Avgiftsbehandling for «${c.label || t}» er ugyldig.`);
    });
    if (!seen.has('salg')) errors.push('Bevegelsestypen «salg» (ordinært salg) må finnes.');
    return errors;
  }

  // ----------------------------------------------------------
  // Append-only lager: en feilført bevegelse rettes med en korreksjonsrad
  // som reverserer den (samme dato og felter, negativt antall). Riktig
  // bevegelse registreres deretter som en ny rad.
  //   original:  raden som skal korrigeres
  //   copyFields: feltene som kopieres (ulikt for stock_in/stock_out)
  //   existing:  alle rader i tabellen (for å hindre dobbel korreksjon)
  // ----------------------------------------------------------
  function buildReversal(original, copyFields, existing) {
    if (!original || original.id == null) throw new SaeravgiftError(['Fant ikke bevegelsen som skal korrigeres.']);
    if (isCorrection(original)) throw new SaeravgiftError(['En korreksjonsrad kan ikke korrigeres. Registrer en ny bevegelse i stedet.']);
    if (!(Number(original.bottles) > 0)) throw new SaeravgiftError(['Bevegelsen har ugyldig antall og kan ikke korrigeres.']);
    if ((existing || []).some(r => r.corrects_id === original.id)) {
      throw new SaeravgiftError(['Bevegelsen er allerede korrigert.']);
    }
    const row = {};
    copyFields.forEach(f => { if (original[f] !== undefined) row[f] = original[f]; });
    row.bottles = -Number(original.bottles);
    row.corrects_id = original.id;
    return row;
  }

  // SHA-256 (hex) av nøyaktig de bytene som lastes ned (UTF-8)
  async function sha256Hex(text) {
    const bytes = new TextEncoder().encode(text);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // Sammenlign gjeldende fil med siste eksport for perioden
  function exportStatus(currentHash, exportsForPeriod) {
    const sorted = [...(exportsForPeriod || [])].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const last = sorted[0] || null;
    if (!last) return { state: 'new', last: null };
    return { state: last.sha256 === currentHash ? 'unchanged' : 'changed', last };
  }

  return {
    BOTTLE_LITERS,
    DEFAULT_GROUPS,
    DEFAULT_MOVEMENT_CODES,
    SaeravgiftError,
    defaultConfig,
    isValidOrgnr,
    toPeriode,
    fmtNumber,
    findGroup,
    findMovementCode,
    classify,
    aggregate,
    buildCsvLine,
    buildCsv,
    movementAmountOre,
    specification,
    preview,
    buildExport,
    validateMovementCodes,
    buildReversal,
    isCorrection,
    sha256Hex,
    exportStatus
  };
});
