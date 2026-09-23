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
function mv(date, product, bottles, extra = {}) {
  return { date, product, bottles, type: 'salg', ...extra };
}

test('16 fl. à 0,75 l vin 12 % i september 2026 gir nøyaktig fil og 779 kr', () => {
  const res = S.buildExport([mv('2026-09-10', vin('Rødvin', 12), 16)], '2026-09', config(), RATES);
  assert.equal(res.csv, `O;${ORGNR};\r\nL;1;BV;516;;2026/09;12;12;`);
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

test('vin 12 % og 13,5 % i samme måned gir to 516-linjer', () => {
  const res = S.buildExport([
    mv('2026-09-01', vin('A', 12), 16),
    mv('2026-09-15', vin('B', 13.5), 4),
    mv('2026-09-20', vin('C', 12), 8)
  ], '2026-09', config(), RATES);
  assert.equal(res.csv, [
    `O;${ORGNR};`,
    'L;1;BV;516;;2026/09;18;12;',
    'L;2;BV;516;;2026/09;3;13.5;'
  ].join('\r\n'));
});

test('retur i oktober av vare levert i september gir tilleggskode 50 og periode 2026/09', () => {
  const res = S.buildExport([
    mv('2026-10-05', vin('Rødvin', 12), 2, { type: 'retur', original_period: '2026-09' })
  ], '2026-10', config(), RATES);
  assert.equal(res.csv, `O;${ORGNR};\r\nL;1;BV;516;50;2026/09;1.5;12;`);
  assert.ok(res.preview.total < 0, 'retur gir fradrag i forhåndsvisningen');
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
    'L;1;BV;516;;2026/09;12;12;',
    'L;2;BV;516;20;2026/09;3;12;',
    'L;3;BV;516;40;2026/09;0.75;12;'
  ].join('\r\n'));
  assert.equal(res.preview.totalAvrundet, 779);
});

test('vin 512–514 får ingen antall2, grupper velges ut fra styrke', () => {
  const res = S.buildExport([
    mv('2026-09-01', vin('Lett', 2.5), 2),
    mv('2026-09-01', vin('Middels', 4.7), 2),
    mv('2026-09-01', vin('Sterk', 18), 2),
    mv('2026-09-01', vin('Grense', 10), 2)
  ], '2026-09', config(), RATES);
  assert.equal(res.csv, [
    `O;${ORGNR};`,
    'L;1;BV;512;;2026/09;1.5;;',
    'L;2;BV;514;;2026/09;1.5;;',
    'L;3;BV;515;;2026/09;1.5;10;',
    'L;4;BV;517;;2026/09;1.5;18;'
  ].join('\r\n'));
});

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

test('antall avrundes til maks 4 desimaler med punktum og uten tusenskille', () => {
  assert.equal(S.fmtNumber(1234.56789, 4), '1234.5679');
  assert.equal(S.fmtNumber(12, 4), '12');
  assert.equal(S.fmtNumber(13.54, 1), '13.5');
});

test('spesifikasjonen har én rad per bevegelse med linjenummer fra filen', () => {
  const res = S.buildExport([
    mv('2026-09-01', vin('A', 12), 16),
    mv('2026-09-20', vin('C', 12), 8)
  ], '2026-09', config(), RATES);
  assert.equal(res.specification.length, 2);
  assert.deepEqual(res.specification.map(r => r['Linjenr i fil']), [1, 1]);
  assert.equal(res.specification[0]['Beregnet avgift (kr)'], 779.04);
});
