# Arıtma Stok Paneli

Su arıtma işletmesi için stok yönetimi, barkodlu toptan/perakende satış, kâr hesabı ve personel yönetimi paneli.
Netlify üzerinde çalışır; ek bir veritabanı hesabı gerekmez (veriler Netlify Blobs'ta tutulur).

## Roller

| | Yönetici | Personel |
|---|---|---|
| Stok listesi | Alış fiyatı ve marjla birlikte | Alış fiyatı olmadan |
| Barkodlu satış | Evet (kâr görünür) | Evet (maliyet ve kâr görünmez) |
| Excel ile stok yükleme, ürün ekleme/düzenleme | Evet | Hayır |
| Kâr hesabı ve satış raporları | Evet | Hayır |
| Personel ekleme, şifre sıfırlama, pasifleştirme | Evet | Hayır |

Maliyet verisi personele hiç gönderilmez; gizleme sunucuda yapılır, yalnızca ekranda saklanmaz.

## Yayına alma (GitHub + Netlify)

### 1. GitHub'a yükleyin

GitHub'da boş bir depo açın (ör. `aritma-stok`), sonra bu klasörde:

```bash
git init
git add .
git commit -m "İlk sürüm"
git branch -M main
git remote add origin https://github.com/KULLANICI_ADINIZ/aritma-stok.git
git push -u origin main
```

Depoyu **Private** (özel) yapmanız önerilir.

### 2. Netlify'a bağlayın

1. Netlify'da **Add new site → Import an existing project → GitHub** deyin ve depoyu seçin.
2. Ayarlar `netlify.toml` dosyasından otomatik gelir (yayın klasörü `public`, build komutu yok). Olduğu gibi bırakın.
3. Deploy etmeden önce **Site configuration → Environment variables** bölümüne şunları ekleyin:

| Değişken | Değer |
|---|---|
| `JWT_SECRET` | En az 32 karakterlik rastgele bir metin. Oturum güvenliği için kullanılır. |
| `ADMIN_PASSWORD` | İlk yönetici hesabının şifresi (güçlü bir şifre seçin). |
| `ADMIN_USERNAME` | İsteğe bağlı. Boşsa `admin` olur. |

Rastgele `JWT_SECRET` üretmek için: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

4. **Deploy site** deyin.

### 3. İlk giriş

Site açılınca kullanıcı adı `admin` (veya `ADMIN_USERNAME`) ve `ADMIN_PASSWORD` ile giriş yapın. İlk girişte yönetici hesabı veritabanına yazılır.
Sonra **Personel** sekmesinden personelinizi ekleyin. Giriş yaptıktan sonra `ADMIN_PASSWORD` değişkenini Netlify'dan silebilirsiniz; hesap zaten oluşmuştur ve şifresini panelden değiştirebilirsiniz.

### 4. Stoğu yükleyin

**Stok** sekmesinden Excel dosyanızı yükleyin. Sütunlar: `Barkod, Ürün Adı, Kategori, Alış Fiyatı, Perakende Fiyatı, Toptan Fiyatı, Stok, Kritik Stok`.
Toptan fiyatı boşsa alış fiyatına belirlediğiniz marj eklenir.

## Yerel çalıştırma

```bash
npm install
npm test                     # sunucu testleri
npx netlify-cli dev          # http://localhost:8888
```

Yerelde çalıştırmak için bir `.env` dosyası oluşturun (`.gitignore` içindedir, GitHub'a gitmez):

```
JWT_SECRET=en-az-32-karakterlik-rastgele-bir-metin
ADMIN_PASSWORD=gecici-bir-sifre
```

## Dosya yapısı

```
public/index.html            Arayüz (giriş, stok, satış, kâr, pazaryeri, personel)
netlify/functions/api.mjs    Netlify fonksiyonu, depolamayı Netlify Blobs'a bağlar
lib/handler.mjs              Tüm sunucu mantığı: giriş, roller, ürün, satış, ayarlar
test/api.test.mjs            Sunucu testleri
netlify.toml                 Netlify ayarları
```

## Bilmeniz gerekenler

- **Pazaryeri entegrasyonu henüz taslak.** Pazaryerleri sekmesi komisyon oranlarını kâr hesabına işler, ancak Trendyol, Hepsiburada gibi sitelere gerçek bağlantı kurmaz. Bu, ayrı bir geliştirme gerektirir (sunucuda pazaryeri API'lerini çağıran fonksiyonlar).
- **Ölçek.** Küçük bir işletme için (birkaç personel, birkaç bin ürün) tasarlandı. İki kişi aynı anda satış yaparsa nadiren stok yazımları çakışabilir. Yoğun kullanımda gerçek bir veritabanına (ör. Supabase) geçmek gerekir.
- **Yedek yok.** Veriler yalnızca Netlify Blobs'ta durur. Ürünleri Excel'den yeniden yükleyebilirsiniz, ancak satış geçmişi için bir yedek özelliği henüz yok.
- **Giriş güvenliği.** Şifreler scrypt ile saklanır, oturum 12 saat geçerlidir, hatalı girişlerde yarım saniye bekletilir. Giriş denemesi sınırlaması (kilitleme) yoktur; güçlü şifreler kullanın.
- Excel okuma kütüphanesi ve yazı tipleri internetten (CDN) yüklenir.
