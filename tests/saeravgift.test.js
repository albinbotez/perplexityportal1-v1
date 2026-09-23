// Kjør: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../saeravgift.js');

const ORGNR = '974760673';
const RATES = { vin: 5.41 };

function config(overrides = {}) {
  return { ...S.defaultConfig(), orgnr: ORGNR, ...overrides };
}
function vin(name, pct) {
  return { name, producer: 'Test', type: 'vin', alcohol_pct: pct };
}
let nextId = 1;
function mv(date, product, bottles, extra = {}) {
  return { id: `m${nextId++}`, date, product, bottles, type: 'salg', ...extra };
}
const semis = line => (line.match(/;/g) || []).length;
const specSumOre = res => res.specification.reduce((a, r) => a + Math.round((Number(r['Estimert avgift (kr)']) || 0) * 100), 0);

// ------------------------------------------------------------
// Filformat
// ------------------------------------------------------------
test('16 fl. à 0,75 l vin 12 % i september 2026 gir nøyaktig fil og 779 kr', () => {
  const res = S.buildExport([mv('2026-09-10', vin('Rødvin', 12), 16)], '2026-09', config(), RATES);
  assert.equal(res.csv, `O;${ORGNR};\r\nL;1;BV;516;;2026/09;12;12;;`);
  assert.equal(res.csvFileName, `saeravgift_${ORGNR}_2026-09.csv`);
  assert.equal(res.preview.rows[0].avgift, 779.04);
  assert.equal(res.preview.total, 779.04);
  assert.equal(res.preview.totalAvrundet, 779);
});

test('CSV har ingen BOM, ingen overskrift og CRLF-linjeskift', () => {
  const res = S.buildExport([mv('2026-09-10', vin('Rødvin', 12), 16)], '2026-09', config(), RATES);
  assert.notEqual(res.csv.charCodeAt(0), 0xfeff);
  assert.ok(res.csv.startsWith('O;'));
  assert.equal(res.csv.split('\r\n').length, 2);
  assert.ok(!/[^\r]\n/.test(res.csv));
});

test('gruppe 512–514 får hele malen med 9 semikolon og tomme antall2/satsår', () => {
  const res = S.buildExport([
    mv('2026-09-01', vin('Lett', 2.5), 2),
    mv('2026-09-01', vin('Lettøl-vin', 3), 2),
    mv('2026-09-01', vin('Middels', 4.7), 2)
  ], '2026-09', config(), RATES);
  const lines = res.csv.split('\r\n').slice(1);
  assert.deepEqual(lines, [
    'L;1;BV;512;;2026/09;1.5;;;',
    'L;2;BV;513;;2026/09;1.5;;;',
    'L;3;BV;514;;2026/09;1.5;;;'
  ]);
  lines.forEach(l => assert.equal(semis(l), 9));
});

test('alle L-linjer har 9 semikolon uansett gruppe og tilleggskode', () => {
  const res = S.buildExport([
    mv('2026-09-01', vin('A', 2.5), 2),
    mv('2026-09-01', vin('B', 8), 2),
    mv('2026-09-01', vin('C', 12), 2, { type: 'eksport' }),
    mv('2026-09-01', vin('D', 18), 2, { type: 'retur', original_period: '2026-08' })
  ], '2026-09', config(), RATES);
  res.csv.split('\r\n').slice(1).forEach(l => assert.equal(semis(l), 9, l));
});

// ------------------------------------------------------------
// Gruppering og tilleggskoder
// ------------------------------------------------------------
test('vin 12 % og 13,5 % i samme måned gir to 516-linjer', () => {
  const res = S.buildExport([
    mv('2026-09-01', vin('A', 12), 16),
    mv('2026-09-15', vin('B', 13.5), 4),
    mv('2026-09-20', vin('C', 12), 8)
  ], '2026-09', config(), RATES);
  assert.equal(res.csv, [
    `O;${ORGNR};`,
    'L;1;BV;516;;2026/09;18;12;;',
    'L;2;BV;516;;2026/09;3;13.5;;'
  ].join('\r\n'));
});

test('retur i oktober av vare levert i september gir tilleggskode 50 og periode 2026/09', () => {
  const res = S.buildExport([
    mv('2026-10-05', vin('Rødvin', 12), 2, { type: 'retur', original_period: '2026-09' })
  ], '2026-10', config(), RATES);
  assert.equal(res.csv, `O;${ORGNR};\r\nL;1;BV;516;50;2026/09;1.5;12;;`);
});

test('retur uten opprinnelig uttaksperiode gir valideringsfeil', () => {
  assert.throws(
    () => S.buildExport([mv('2026-10-05', vin('Rødvin', 12), 2, { type: 'retur' })], '2026-10', config(), RATES),
    err => err instanceof S.SaeravgiftError && /uttaksperiode/.test(err.message)
  );
});

test('avgiftsfrie bevegelser får egne linjer og nettoføres ikke bort', () => {
  const res = S.buildExport([
    mv('2026-09-01', vin('A', 12), 16),
    mv('2026-09-02', vin('A', 12), 4, { type: 'eksport' }),
    mv('2026-09-03', vin('A', 12), 1, { type: 'tilintetgjort' })
  ], '2026-09', config(), RATES);
  assert.equal(res.csv, [
    `O;${ORGNR};`,
    'L;1;BV;516;;2026/09;12;12;;',
    'L;2;BV;516;20;2026/09;3;12;;',
    'L;3;BV;516;40;2026/09;0.75;12;;'
  ].join('\r\n'));
  assert.equal(res.preview.totalAvrundet, 779);
});

test('grupper velges ut fra styrke', () => {
  const res = S.buildExport([
    mv('2026-09-01', vin('Sterk', 18), 2),
    mv('2026-09-01', vin('Grense', 10), 2)
  ], '2026-09', config(), RATES);
  assert.deepEqual(res.csv.split('\r\n').slice(1), [
    'L;1;BV;515;;2026/09;1.5;10;;',
    'L;2;BV;517;;2026/09;1.5;18;;'
  ]);
});

test('ny tilleggskode kan legges til i tabellen uten kodeendring', () => {
  const cfg = config();
  cfg.movementCodes = [...cfg.movementCodes,
    { type: 'eksport_svalbard', label: 'Eksport til Svalbard/Jan Mayen', kode: '21', lagerRetning: -1, avgiftFortegn: 0, krevPeriode: false }];
  assert.deepEqual(S.validateMovementCodes(cfg.movementCodes), []);
  const res = S.buildExport([mv('2026-09-01', vin('A', 12), 4, { type: 'eksport_svalbard' })], '2026-09', cfg, RATES);
  assert.equal(res.csv.split('\r\n')[1], 'L;1;BV;516;21;2026/09;3;12;;');
});

test('ugyldige tilleggskoder i tabellen avvises', () => {
  const errs = S.validateMovementCodes([
    { type: 'salg', label: 'Salg', kode: '', lagerRetning: -1, avgiftFortegn: 1 },
    { type: 'Ny Type', label: 'X', kode: '2', lagerRetning: 0, avgiftFortegn: 5 }
  ]);
  assert.equal(errs.length, 4);
});

// ------------------------------------------------------------
// Validering
// ------------------------------------------------------------
test('vare uten styrke gir valideringsfeil og ingen fil', () => {
  let res;
  assert.throws(
    () => { res = S.buildExport([mv('2026-09-01', vin('Ukjent', null), 1)], '2026-09', config(), RATES); },
    err => err instanceof S.SaeravgiftError && /mangler styrke/.test(err.message)
  );
  assert.equal(res, undefined);
});

test('vare som ikke passer i noen gruppe gir valideringsfeil', () => {
  assert.throws(
    () => S.buildExport([mv('2026-09-01', { name: 'Akevitt', type: 'brennevin', alcohol_pct: 40 }, 1)], '2026-09', config(), RATES),
    err => err instanceof S.SaeravgiftError && /passer ikke i noen avgiftsgruppe/.test(err.message)
  );
});

test('manglende eller ugyldig orgnr gir valideringsfeil og ingen fil', () => {
  for (const orgnr of ['', '123456789', '97476067']) {
    assert.throws(
      () => S.buildExport([mv('2026-09-01', vin('A', 12), 1)], '2026-09', config({ orgnr }), RATES),
      err => err instanceof S.SaeravgiftError && /Organisasjonsnummer/.test(err.message)
    );
  }
});

test('negativt antall uten korreksjonsreferanse avvises', () => {
  assert.throws(
    () => S.buildExport([mv('2026-09-01', vin('A', 12), -2)], '2026-09', config(), RATES),
    err => err instanceof S.SaeravgiftError && /korreksjonsrader/.test(err.message)
  );
});

test('antall avrundes til maks 4 desimaler med punktum og uten tusenskille', () => {
  assert.equal(S.fmtNumber(1234.56789, 4), '1234.5679');
  assert.equal(S.fmtNumber(12, 4), '12');
  assert.equal(S.fmtNumber(13.54, 1), '13.5');
});

// ------------------------------------------------------------
// Beregning: gulv-avrunding og sum fra spesifikasjonen
// ------------------------------------------------------------
test('negativ forhåndsvisningssum rundes ned (gulv): −97,38 → −98', () => {
  const res = S.buildExport([
    mv('2026-10-05', vin('Rødvin', 12), 2, { type: 'retur', original_period: '2026-09' })
  ], '2026-10', config(), RATES);
  assert.equal(res.preview.rows[0].avgift, -97.38);
  assert.equal(res.preview.total, -97.38);
  assert.equal(res.preview.totalAvrundet, -98);
});

test('beløp per bevegelse gulv-avrundes til øre, også negative', () => {
  // 0,75 l × 13,5 × 5,41 = 54,77625
  const pos = S.buildExport([mv('2026-09-01', vin('B', 13.5), 1)], '2026-09', config(), RATES);
  assert.equal(pos.specification[0]['Estimert avgift (kr)'], 54.77);
  const neg = S.buildExport([mv('2026-10-01', vin('B', 13.5), 1, { type: 'retur', original_period: '2026-09' })], '2026-10', config(), RATES);
  assert.equal(neg.specification[0]['Estimert avgift (kr)'], -54.78);
});

test('forhåndsvisningens linjer og totalsum er summen av spesifikasjonsradene', () => {
  const res = S.buildExport([
    mv('2026-09-03', vin('B', 13.5), 1),
    mv('2026-09-04', vin('B', 13.5), 1),
    mv('2026-09-05', vin('A', 12), 16),
    mv('2026-09-06', vin('A', 12), 3, { type: 'retur', original_period: '2026-08' })
  ], '2026-09', config(), RATES);
  assert.equal(res.preview.totalOre, specSumOre(res));
  // Linjen med to bevegelser à 54,77 viser 109,54 (ikke 109,55 regnet på linjen)
  const line135 = res.preview.rows.find(r => r.styrke === 13.5);
  assert.equal(line135.avgift, 109.54);
  res.preview.rows.forEach(r => {
    const sum = res.specification.filter(x => x['Linjenr i fil'] === r.linjenr)
      .reduce((a, x) => a + Math.round(x['Estimert avgift (kr)'] * 100), 0);
    assert.equal(Math.round(r.avgift * 100), sum);
  });
});

// ------------------------------------------------------------
// Append-only: korreksjon av tidligere bevegelse
// ------------------------------------------------------------
const STOCK_OUT_FIELDS = ['product_id', 'customer_id', 'sale_date', 'movement_type', 'original_period', 'document_ref'];

test('korreksjon av en tidligere bevegelse reverserer den og endrer periodens fil', () => {
  const p = vin('Rødvin', 12);
  const feil = { id: 'so-1', product_id: 'p1', customer_id: 'c1', sale_date: '2026-09-10', movement_type: 'salg', document_ref: 'F-1001', bottles: 16 };
  const toRow = r => ({ id: r.id, date: r.sale_date, type: r.movement_type, bottles: r.bottles, document_ref: r.document_ref, corrects_id: r.corrects_id, product: p });

  const foer = S.buildExport([toRow(feil)], '2026-09', config(), RATES);
  assert.equal(foer.csv.split('\r\n')[1], 'L;1;BV;516;;2026/09;12;12;;');

  // Korreksjonsrad: samme dato og felter, negativt antall, peker på originalen
  const rev = { id: 'so-2', ...S.buildReversal(feil, STOCK_OUT_FIELDS, [feil]) };
  assert.deepEqual(rev, { id: 'so-2', product_id: 'p1', customer_id: 'c1', sale_date: '2026-09-10', movement_type: 'salg', document_ref: 'F-1001', bottles: -16, corrects_id: 'so-1' });
  // Riktig bevegelse registreres som ny rad (10 fl. i stedet for 16)
  const riktig = { ...feil, id: 'so-3', bottles: 10 };

  const etter = S.buildExport([feil, rev, riktig].map(toRow), '2026-09', config(), RATES);
  assert.equal(etter.csv, `O;${ORGNR};\r\nL;1;BV;516;;2026/09;7.5;12;;`);
  // Spesifikasjonen viser hele historikken: original, korreksjon og ny rad
  assert.equal(etter.specification.length, 3);
  assert.deepEqual(etter.specification.map(r => r['Estimert avgift (kr)']), [779.04, -779.04, 486.9]);
  assert.equal(etter.preview.total, 486.9);
  assert.equal(etter.preview.totalOre, specSumOre(etter));
});

test('korreksjon som opphever hele linjen fjerner den fra filen, men ikke fra spesifikasjonen', () => {
  const a = { id: 'a', sale_date: '2026-09-01', movement_type: 'salg', bottles: 1, product: vin('Sterk', 13.5) };
  const b = { id: 'b', sale_date: '2026-09-02', movement_type: 'salg', bottles: 16, product: vin('Rødvin', 12) };
  const revA = { id: 'r', product: a.product, ...S.buildReversal(a, ['sale_date', 'movement_type'], [a, b]) };
  const toRow = r => ({ id: r.id, date: r.sale_date, type: r.movement_type, bottles: r.bottles, corrects_id: r.corrects_id, product: r.product });
  const res = S.buildExport([a, b, revA].map(toRow), '2026-09', config(), RATES);
  // 13,5 %-linjen er borte, og linjenummereringen er fortløpende
  assert.equal(res.csv, `O;${ORGNR};\r\nL;1;BV;516;;2026/09;12;12;;`);
  assert.equal(res.specification.length, 3);
  const byId = id => res.specification.find(r => r['Bevegelses-ID'] === id);
  assert.equal(byId('a')['Linjenr i fil'], '');
  assert.equal(byId('r')['Linjenr i fil'], '');
  // Originalen (54,77) og korreksjonen (−54,77) opphever hverandre eksakt
  assert.equal(byId('a')['Estimert avgift (kr)'], 54.77);
  assert.equal(byId('r')['Estimert avgift (kr)'], -54.77);
  assert.equal(res.preview.total, 779.04);
  assert.equal(res.preview.totalOre, specSumOre(res));
});

test('en bevegelse kan ikke korrigeres to ganger, og korreksjoner kan ikke korrigeres', () => {
  const a = { id: 'a', sale_date: '2026-09-01', bottles: 2 };
  const rev = { id: 'r', ...S.buildReversal(a, ['sale_date'], [a]) };
  assert.throws(() => S.buildReversal(a, ['sale_date'], [a, rev]), /allerede korrigert/);
  assert.throws(() => S.buildReversal(rev, ['sale_date'], [a, rev]), /korreksjonsrad kan ikke korrigeres/);
});

test('korreksjon uten tilhørende bevegelse i perioden gir feil', () => {
  const p = vin('Rødvin', 12);
  assert.throws(
    () => S.buildExport([{ id: 'r', date: '2026-09-01', type: 'salg', bottles: -2, corrects_id: 'x', product: p }], '2026-09', config(), RATES),
    err => err instanceof S.SaeravgiftError && /Negativt antall/.test(err.message)
  );
});

// ------------------------------------------------------------
// Eksportlogg
// ------------------------------------------------------------
test('hash av filinnhold (SHA-256) og status mot forrige eksport', async () => {
  assert.equal(await S.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const res = S.buildExport([mv('2026-09-10', vin('Rødvin', 12), 16)], '2026-09', config(), RATES);
  const hash = await S.sha256Hex(res.csv);
  assert.equal(S.exportStatus(hash, []).state, 'new');
  const log = [{ created_at: '2026-10-01T10:00:00Z', sha256: 'gammel' }, { created_at: '2026-10-02T10:00:00Z', sha256: hash }];
  assert.equal(S.exportStatus(hash, log).state, 'unchanged');
  assert.equal(S.exportStatus('annen', log).state, 'changed');
});
