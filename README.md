# Albion Online Event Creator Discord Bot

Bu bot, Albion Online ve benzeri MMO'lar için gelişmiş bir şablon tabanlı etkinlik/içerik düzenleme botudur. Guild liderlerinin/yöneticilerinin tek bir modal formu üzerinden grup kompozisyonlarını ve build gereksinimlerini otomatik olarak ayrıştırıp görsel şölen sunan Discord Embed mesajları oluşturmasını sağlar.

---

## 🚀 Özellikler

1. **Şablon (Template) Sistemi**:
   - **Basit Format**: Sadece alt alta roller yazılarak boş slotlar oluşturulur.
   - **Gelişmiş Format**: `#` karakteri ile rol grupları (Tanks, Healers vb.) oluşturulabilir. `>` karakteri ile o role özel build/ekipman bilgisi yazılabilir.
2. **Görsel Tasarım**:
   - Albion Online temalı altın/amber renk paleti.
   - Emojisiz, sade ve göz yormayan minimalist arayüz.
   - Dinamik progress bar doluluk göstergesi (`▰▰▰▱▱▱ %50`).
3. **Zengin Etkileşimler**:
   - **Rol Seç Menüsü**: Boş ve dolu rollerin tümünü listeleyen açılır menü. Bir kişi rol seçtiğinde otomatik o role atanır ve eski rolünden çıkarılır.
   - **Ayrıl Butonu**: Kullanıcının etkinlikten çıkmasını sağlar.
   - **Ayarlar Butonu (Lidere Özel)**: Ephemeral (sadece lidere görünen) yönetim menüsü açar. Buradan etkinlik başlığı/açıklaması ve rolleri tek modalda düzenlenebilir, katılımcılara toplu ping atılabilir veya etkinlik sonlandırılabilir.
4. **Güvenlik ve Otomatik Temizleme (48 Saat Retention & Limitler)**:
   - **Kullanıcı Başına 3 Aktif Etkinlik**: Bir kullanıcı aynı anda en fazla 3 aktif etkinlik açabilir. 4. etkinliği açmaya çalıştığında, en eski etkinliği veritabanından silinir ve Discord'da otomatik olarak sonlandırılır.
   - **48 Saatlik Temizlik**: Kapatılması unutulan tüm etkinlikler, oluşturulduktan 48 saat sonra veritabanından otomatik olarak temizlenir.

---

## ⚙️ Kurulum ve Çalıştırma

1. Projeyi indirin/kopyalayın.
2. Bağımlılıkları yükleyin:
   ```bash
   npm install
   ```
3. `.env.example` dosyasını kopyalayıp adını `.env` yapın ve içindeki bilgileri doldurun:
   - `DISCORD_TOKEN`: Discord Developer Portal'dan aldığınız bot tokenı.
   - `CLIENT_ID`: Discord Developer Portal'dan aldığınız Application/Client ID'si.
4. Botu başlatın:
   ```bash
   npm start
   ```

---

## 📝 Şablon Örnekleri

Botu test etmek için aşağıdaki şablonları kopyalayıp `/create-content` modalındaki şablon kısmına yapıştırabilirsiniz.

### Örnek 1: Gelişmiş Format (Albion Static / PvE Buildler)
```text
#Tanks
Mace > Astral aegis - Cleric cowl - Armor of valor
Heavy Mace > Hellion hood - Guardian armor

#Healers
Hallowfall > Mistcaller - Druid robe - Soldier helmet
Wild Staff > Mercenary hood - Cleric robe

#Support
Arcane > Locus - Mercenary hood - Guardian armor

#DPS
Light Crossbow > Cryptcandle - Royal cowl - Druid robe
Realmbreaker > Hellion jacket - Royal hood
Realmbreaker > Hellion jacket - Royal hood
Spirithunter > Royal jacket - Scholar cowl
Spirithunter > Royal jacket - Scholar cowl
```

### Örnek 2: Basit Format (Kategori ve buildsiz)
```text
Tank
Healer
DPS
DPS
DPS
```
