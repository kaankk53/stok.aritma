// Yönetici paneli: Siparişler (pazaryeri / web siparişlerinin elle takibi)
(function () {
'use strict';
const { $, esc, fmt, tarih, bugun, parseNum, toast } = AS;

const KANAL = { trendyol: 'Trendyol', hepsiburada: 'Hepsiburada', n11: 'n11', amazon: 'Amazon', ciceksepeti: 'ÇiçekSepeti', web: 'Web sitesi' };
const DURUM = { bekliyor: 'Bekliyor', hazirlaniyor: 'Hazırlanıyor', kargoda: 'Kargoda', teslim: 'Teslim edildi', iptal: 'İptal' };
const TON = { bekliyor: 'warn', hazirlaniyor: 'warn', kargoda: '', teslim: 'ok', iptal: 'bad' };
const SONRAKI = { bekliyor: ['hazirlaniyor', 'Hazırlanıyor'], hazirlaniyor: ['kargoda', 'Kargoya ver'], kargoda: ['teslim', 'Teslim edildi'] };

let L = [], filtre = { durum: 'acik', kanal: '' }, form = null, gen = 0;
const kok = () => $('#sip-kok');
const api = (...a) => AD.api(...a);
const opt = (obj, sec, bos) => (bos ? `<option value="">${esc(bos)}</option>` : '') + Object.keys(obj).map((k) => `<option value="${k}"${k === sec ? ' selected' : ''}>${esc(obj[k])}</option>`).join('');

function yeniForm() { return { kanal: 'trendyol', harici: '', musteri: '', telefon: '', adres: '', tarih: bugun(), notlar: '', satirlar: [{ barkod: '', adet: 1, fiyat: '' }] }; }

async function render() {
  const my = ++gen;
  let l;
  try {
    const q = new URLSearchParams();
    if (filtre.durum) q.set('durum', filtre.durum);
    if (filtre.kanal) q.set('kanal', filtre.kanal);
    l = await api('orders' + (q.toString() ? '?' + q : ''));
    await AD.urunleriYenile();
  } catch (e) { toast(e.message, 'bad'); return; }
  if (my !== gen) return;
  L = l; ciz();
}

function ciz() {
  const bek = L.filter((x) => x.durum === 'bekliyor' || x.durum === 'hazirlaniyor');
  const satirlar = L.map((s) => {
    const sn = SONRAKI[s.durum];
    const urun = s.satirlar.map((x) => `${esc(x.ad)} ×${x.adet}`).join(', ');
    return `<tr>
      <td><strong class="mono">${esc(s.no)}</strong><div class="muted">${tarih(s.tarih)}</div></td>
      <td>${esc(KANAL[s.kanal] || s.kanal)}${s.harici ? `<div class="muted mono">${esc(s.harici)}</div>` : ''}</td>
      <td>${esc(s.musteri || '-')}${s.telefon ? `<div class="muted">${esc(s.telefon)}</div>` : ''}</td>
      <td>${urun}</td>
      <td class="num">${fmt(s.tutar)}</td>
      <td><span class="pill ${TON[s.durum]}">${esc(DURUM[s.durum])}</span></td>
      <td class="act">${sn ? `<button class="btn sm primary" data-sa="durum" data-id="${s.id}" data-d="${sn[0]}">${sn[1]}</button>` : ''}
        ${s.durum !== 'iptal' && s.durum !== 'teslim' ? `<button class="btn sm" data-sa="durum" data-id="${s.id}" data-d="iptal">İptal</button>` : ''}
        ${s.durum === 'iptal' ? `<button class="btn sm" data-sa="durum" data-id="${s.id}" data-d="bekliyor">Yeniden aç</button>` : ''}
        ${!s.saleId ? `<button class="btn sm" data-sa="sil" data-id="${s.id}">Sil</button>` : ''}</td></tr>`;
  }).join('');
  kok().innerHTML = `
    <div class="card"><div class="head"><h2>Siparişler</h2><button class="btn primary" data-sa="yeni">Yeni sipariş</button></div>
      <p class="muted">Pazaryeri veya web siparişini buraya girin. <strong>Kargoya verildiğinde</strong> stoktan düşer ve ciroya işlenir; iptal edilirse geri alınır.</p>
      <div class="mini"><label class="f">Durum<select id="sf-durum">${opt({ acik: 'Açık (bekleyen)', '': 'Tümü', ...DURUM }, filtre.durum)}</select></label>
      <label class="f">Pazaryeri<select id="sf-kanal">${opt(KANAL, filtre.kanal, 'Tümü')}</select></label>
      <div class="muted" style="align-self:center">${L.length} sipariş · bekleyen ${bek.length} (${fmt(bek.reduce((a, x) => a + x.tutar, 0))})</div></div></div>
    ${form ? formHtml() : ''}
    <div class="card"><div class="tw"><table><thead><tr><th>No</th><th>Pazaryeri</th><th>Müşteri</th><th>Ürünler</th><th class="num">Tutar</th><th>Durum</th><th></th></tr></thead>
      <tbody>${satirlar || '<tr><td colspan="7" class="empty">Sipariş yok.</td></tr>'}</tbody></table></div></div>`;
}

function formHtml() {
  const f = form;
  const urunler = AD.urunler();
  const rows = f.satirlar.map((s, i) => {
    const u = urunler.find((x) => x.barkod === s.barkod);
    return `<div class="mini" data-i="${i}"><label class="f grow">Ürün (barkod / ad)<input data-sf="barkod" list="urunListesi" value="${esc(s.barkod)}" autocomplete="off"></label>
      <label class="f" style="flex:0 0 90px">Adet<input data-sf="adet" type="number" min="1" step="1" value="${esc(s.adet)}"></label>
      <label class="f" style="flex:0 0 130px">Birim fiyat<input data-sf="fiyat" inputmode="decimal" value="${esc(s.fiyat)}" placeholder="${u ? u.perakende : ''}"></label>
      <button class="btn sm" data-sa="satir-sil" data-i="${i}">×</button></div>${u ? `<div class="muted">${esc(u.ad)} · stok ${u.stok}</div>` : ''}`;
  }).join('');
  return `<div class="card"><div class="head"><h2>Yeni sipariş</h2></div>
    <div class="mini"><label class="f">Pazaryeri<select data-sf="kanal">${opt(KANAL, f.kanal)}</select></label>
      <label class="f">Pazaryeri sipariş no<input data-sf="harici" value="${esc(f.harici)}"></label>
      <label class="f">Tarih<input data-sf="tarih" type="date" value="${esc(f.tarih)}"></label></div>
    <div class="mini"><label class="f">Müşteri<input data-sf="musteri" value="${esc(f.musteri)}"></label>
      <label class="f">Telefon<input data-sf="telefon" value="${esc(f.telefon)}"></label>
      <label class="f grow">Adres<input data-sf="adres" value="${esc(f.adres)}"></label></div>
    ${rows}
    <div class="mini"><button class="btn" data-sa="satir-ekle">+ Ürün ekle</button>
      <label class="f grow">Not<input data-sf="notlar" value="${esc(f.notlar)}"></label></div>
    <div class="mini"><button class="btn primary" data-sa="kaydet">Siparişi kaydet</button><button class="btn" data-sa="vazgec">Vazgeç</button></div></div>`;
}

function formOku() {
  document.querySelectorAll('#sip-kok [data-sf]').forEach((el) => {
    const row = el.closest('[data-i]'); const k = el.dataset.sf;
    if (row) form.satirlar[+row.dataset.i][k] = el.value; else form[k] = el.value;
  });
}

async function tikla(e) {
  const b = e.target.closest('[data-sa]'); if (!b) return;
  const a = b.dataset.sa;
  try {
    if (a === 'yeni') { form = yeniForm(); ciz(); }
    else if (a === 'vazgec') { form = null; ciz(); }
    else if (a === 'satir-ekle') { formOku(); form.satirlar.push({ barkod: '', adet: 1, fiyat: '' }); ciz(); }
    else if (a === 'satir-sil') { formOku(); form.satirlar.splice(+b.dataset.i, 1); if (!form.satirlar.length) form.satirlar.push({ barkod: '', adet: 1, fiyat: '' }); ciz(); }
    else if (a === 'kaydet') {
      formOku();
      const urunler = AD.urunler();
      const satirlar = form.satirlar.filter((s) => s.barkod).map((s) => {
        const u = urunler.find((x) => x.barkod === s.barkod);
        const f = s.fiyat === '' ? (u ? u.perakende : 0) : parseNum(s.fiyat);
        return { barkod: s.barkod, adet: parseNum(s.adet), fiyat: f };
      });
      await api('orders', { method: 'POST', body: { ...form, satirlar } });
      form = null; toast('Sipariş kaydedildi'); await render();
    } else if (a === 'durum') {
      await api(`orders/${b.dataset.id}/durum`, { method: 'POST', body: { durum: b.dataset.d } });
      toast('Durum güncellendi'); await render();
    } else if (a === 'sil') {
      if (!confirm('Sipariş silinsin mi?')) return;
      await api(`orders/${b.dataset.id}`, { method: 'DELETE' }); await render();
    }
  } catch (err) { toast(err.message, 'bad'); }
}

function degis(e) {
  if (e.target.id === 'sf-durum') { filtre.durum = e.target.value; render(); }
  else if (e.target.id === 'sf-kanal') { filtre.kanal = e.target.value; render(); }
  else if (e.target.matches('[data-sf="barkod"]') && form) { formOku(); ciz(); }
}

document.addEventListener('click', tikla);
document.addEventListener('change', degis);
window.SIP = { render, sifirla() { form = null; } };
})();
