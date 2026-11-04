# Accord — Product Requirements Document (Codegeist 2026)

Nov 2, 2026 · @Bayu Kaktua · Status: Draft

## Ringkasan

Accord adalah aplikasi Forge di mana agen Rovo mewakili setiap tim dan menegosiasikan dependensi antar-tim berdasarkan kapasitas dan prioritas nyata, lalu menghasilkan kesepakatan yang tinggal disetujui kedua team lead. Accord menyasar kategori **Apps for Software Teams** dengan bonus utama **Best Agents – Rovo/Assignable agents**.

### Latar belakang

Di organisasi dengan banyak tim, sebagian besar keterlambatan tidak terjadi di dalam satu tim, tetapi di antara tim. Tim A butuh sesuatu dari tim B. Permintaan dibuat sebagai issue atau link "blocked by", lalu diselesaikan lewat rapat, pesan chat, dan janji lisan. Tidak ada yang menghitung apakah tim B benar-benar punya kapasitas, pekerjaan apa yang harus digeser, atau seberapa mahal keterlambatannya bagi tim A.

Alat yang ada, seperti fitur dependensi di Jira Plans dan aplikasi pemetaan dependensi di Marketplace, *menampilkan* dependensi. Belum ada yang *menyelesaikannya*: menyusun opsi, menimbang konsekuensinya, dan mengubah hasilnya menjadi komitmen yang dipantau.

### Pernyataan masalah

> Team lead tidak punya cara cepat dan berbasis data untuk menyepakati dependensi lintas tim, sehingga kesepakatan dibuat lambat, tidak tercatat, dan baru diketahui gagal saat tenggat sudah lewat.

### Kenapa sekarang

Rovo agents, Teamwork Graph, dan MCP kini tersedia untuk aplikasi Forge. Untuk pertama kalinya, sebuah aplikasi bisa membaca struktur tim dan pekerjaan lintas produk, menjalankan agen yang bertindak atas nama tim, dan menerima permintaan dari agen di luar Atlassian. Accord dibangun di atas ketiganya.

## Tujuan dan non-tujuan

Accord berhasil jika dependensi lintas tim disepakati dalam hitungan menit dengan data yang bisa dipercaya, dan pelanggaran kesepakatan diketahui jauh sebelum tenggat.

### Tujuan

1. **Kesepakatan cepat.** Permintaan dependensi menghasilkan deal sheet yang siap disetujui tanpa rapat.
2. **Berbasis data.** Setiap opsi didasarkan pada kapasitas historis, komitmen yang ada, prioritas yang tercatat, dan piagam tim, bukan pada siapa yang paling vokal.
3. **Bisa dijelaskan.** Setiap opsi menunjukkan apa yang digeser, kenapa, dan konsekuensinya bagi kedua tim.
4. **Manusia yang memutuskan.** Agen tidak pernah membuat komitmen sendiri; kedua team lead selalu menyetujui.
5. **Peringatan dini.** Kontrak yang mulai meleset diketahui tim peminta sejak awal, lengkap dengan opsi negosiasi ulang.

### Non-tujuan

- **Bukan alat perencanaan portofolio.** Accord tidak menggantikan Jira Plans atau roadmap; ia menangani dependensi satu per satu.
- **Bukan penilai kinerja tim.** Tidak ada skor atau peringkat tim berdasarkan kontrak yang meleset.
- **Bukan perencana otomatis.** Accord tidak memindahkan pekerjaan antar-sprint tanpa persetujuan eksplisit.
- **Bukan estimasi presisi.** Kapasitas ditampilkan sebagai rentang, bukan janji angka pasti.
- **Bukan untuk dependensi di dalam satu tim.** Fokusnya hanya antar-tim.

## Persona pengguna

Empat persona memakai Accord; dua yang pertama adalah pengguna inti yang harus dilayani sempurna di MVP.

| Persona | Peran dalam Accord | Kebutuhan utama | Kekhawatiran |
| --- | --- | --- | --- |
| **Rani, team lead peminta** (tim Mobile) | Mengajukan permintaan dependensi dan menyetujui deal sheet | Kepastian tanggal yang realistis dan peringatan cepat jika meleset | Permintaannya diabaikan atau dijanjikan lalu terlupa |
| **Dimas, team lead penyedia** (tim Payments) | Menerima permintaan, menetapkan piagam tim, menyetujui deal sheet | Melindungi fokus tim dan tidak terus-menerus diinterupsi | Dipaksa menerima pekerjaan oleh agen atau oleh tim yang paling keras bersuara |
| **Sari, engineering manager** (atasan kedua tim) | Menerima eskalasi dan melihat jaringan dependensi | Ringkasan netral saat dua tim tidak sepakat, gambaran risiko dependensi | Konflik antar-tim baru terdengar saat sudah terlambat |
| **Agen eksternal** (Claude Code, agen tim lain) | Mengajukan atau mengecek permintaan lewat MCP | Antarmuka terstruktur dan respons yang bisa diproses mesin | (Tidak berlaku) |

Persona penyedia (Dimas) adalah yang paling menentukan keberhasilan. Jika ia merasa Accord adalah alat untuk menekan timnya, ia tidak akan menulis piagam dan seluruh sistem kehilangan dasarnya. Karena itu piagam tim, hak tolak, dan garis merah menjadi kebutuhan P0.

## Alur pengguna utama

Satu permintaan dependensi melewati sembilan langkah; agen bekerja di baris atas, manusia memutuskan di baris bawah.

&#91;embedded content: alur utama Accord · 9 langkah, 1 loop negosiasi ulang\]

Pemantauan harian membuka kembali negosiasi saat kontrak berisiko, sehingga kesepakatan tetap hidup selama pekerjaan berjalan. Permintaan yang ditolak kedua pihak bisa dieskalasi ke atasan bersama yang ditemukan lewat Teamwork Graph.

## User stories dan acceptance criteria

Cerita dikelompokkan per tahap alur; ID dipakai untuk merujuk dari kebutuhan fungsional.

| ID | User story | Acceptance criteria |
| --- | --- | --- |
| US-1 | Sebagai team lead penyedia, saya ingin menulis piagam tim agar agen bernegosiasi sesuai aturan tim saya | Piagam di halaman Confluence dengan template Accord terbaca dan tervalidasi; field yang hilang ditandai; perubahan piagam berlaku untuk negosiasi berikutnya |
| US-2 | Sebagai team lead peminta, saya ingin mengajukan permintaan dari issue Jira agar tidak perlu berpindah alat | Tombol "Request with Accord" di issue; form berisi tim tujuan, deskripsi kebutuhan, tanggal dibutuhkan, dan goal atau epic terkait; permintaan tercatat dalam waktu kurang dari 5 detik |
| US-3 | Sebagai team lead peminta, saya ingin link "blocked by" baru otomatis disarankan menjadi permintaan | Saat link lintas tim dibuat, muncul saran di panel issue; tidak ada permintaan yang dibuat tanpa klik pengguna |
| US-4 | Sebagai team lead penyedia, saya ingin melihat opsi realistis berdasarkan kapasitas tim saya | Minimal 2 dan maksimal 4 opsi; setiap opsi menampilkan tanggal (rentang), pekerjaan yang digeser, dan aturan piagam yang dipakai; tidak ada opsi yang melanggar garis merah |
| US-5 | Sebagai team lead, saya ingin memahami kenapa sebuah opsi direkomendasikan | Setiap opsi punya penjelasan langkah demi langkah dari perencana; angka di penjelasan sama persis dengan data yang dipakai perencana |
| US-6 | Sebagai kedua team lead, saya ingin menyetujui satu opsi dalam satu layar | Deal sheet menampilkan opsi rekomendasi dan alternatif; kontrak hanya dibuat setelah kedua pihak menyetujui; salah satu pihak bisa menolak dengan alasan |
| US-7 | Sebagai team lead peminta, saya ingin kesepakatan otomatis tercatat di Jira | Setelah disetujui: issue tertaut dibuat atau diperbarui dengan tanggal yang disepakati, pekerjaan yang disetujui untuk digeser dipindahkan, dan kontrak terlihat di panel kedua issue |
| US-8 | Sebagai team lead peminta, saya ingin diberi tahu jika kontrak mulai meleset | Status kontrak dievaluasi harian; jika proyeksi melewati tanggal kontrak, kedua team lead diberi tahu dan negosiasi ulang dibuka dengan opsi baru |
| US-9 | Sebagai engineering manager, saya ingin menerima eskalasi yang netral saat tim tidak sepakat | Setelah dua putaran tanpa kesepakatan, ringkasan berisi posisi kedua tim, opsi, dan data dikirim ke atasan bersama dari Teamwork Graph |
| US-10 | Sebagai engineering manager, saya ingin melihat jaringan dependensi lintas tim | Halaman global menampilkan tim sebagai simpul, kontrak sebagai sisi, dan kontrak berisiko ditandai |
| US-11 | Sebagai agen eksternal, saya ingin mengajukan dan mengecek permintaan lewat MCP | Tool `request_dependency` dan `list_contracts` mengembalikan JSON terstruktur; permintaan dari MCP tetap butuh persetujuan manusia |

## Kebutuhan fungsional

P0 wajib ada di submission Codegeist, P1 dikerjakan jika waktu cukup, P2 untuk setelah kompetisi.

| ID | Kebutuhan | Prioritas | Story |
| --- | --- | --- | --- |
| FR-1 | Membaca dan memvalidasi piagam tim dari halaman Confluence bertemplate | P0 | US-1 |
| FR-2 | Mengajukan permintaan dependensi dari issue Jira | P0 | US-2 |
| FR-3 | Menghitung kapasitas tim dari throughput historis (issue selesai per sprint) sebagai rentang | P0 | US-4 |
| FR-4 | Menghitung komitmen yang sudah ada dari sprint aktif, sprint berikutnya, dan due date | P0 | US-4 |
| FR-5 | Menghitung bobot permintaan dari goal atau epic terkait dan biaya keterlambatan | P0 | US-4 |
| FR-6 | Perencana deterministik yang menghasilkan 2–4 opsi dan tidak pernah melanggar garis merah | P0 | US-4 |
| FR-7 | Penjelasan langkah demi langkah untuk setiap opsi | P0 | US-5 |
| FR-8 | Negosiasi antar-agen maksimal dua putaran, menghasilkan deal sheet | P0 | US-6 |
| FR-9 | Persetujuan dua pihak sebelum kontrak dibuat | P0 | US-6 |
| FR-10 | Pembuatan kontrak: issue tertaut, tanggal, penggeseran pekerjaan yang disetujui | P0 | US-7 |
| FR-11 | Evaluasi kontrak harian dan pemberitahuan saat proyeksi melewati tanggal kontrak | P0 | US-8 |
| FR-12 | Agen Rovo Team Delegate dan Broker dengan action reusable | P0 | US-4, US-6 |
| FR-13 | Menulis relasi `agreed-dependency` ke Teamwork Graph (fallback: Forge SQL) | P0 | US-7 |
| FR-14 | Negosiasi ulang otomatis dengan opsi baru saat kontrak berisiko | P1 | US-8 |
| FR-15 | Eskalasi ke atasan bersama dengan ringkasan netral | P1 | US-9 |
| FR-16 | Saran permintaan dari link "blocked by" lintas tim | P1 | US-3 |
| FR-17 | Peta jaringan dependensi lintas tim | P1 | US-10 |
| FR-18 | Tool MCP `request_dependency` dan `list_contracts` | P1 | US-11 |
| FR-19 | Riwayat dan analitik kontrak (berapa yang ditepati, rata-rata waktu kesepakatan) | P2 | — |
| FR-20 | Negosiasi lebih dari dua tim untuk satu permintaan | P2 | — |

## Kebutuhan non-fungsional

Kepercayaan adalah kebutuhan non-fungsional terpenting: team lead hanya akan memakai Accord jika angka dan opsinya bisa diperiksa dan tidak ada yang berubah tanpa izin mereka.

| ID | Kategori | Kebutuhan |
| --- | --- | --- |
| NFR-1 | Keterjelasan | Setiap angka yang ditampilkan agen berasal dari perencana deterministik. LLM hanya menyusun kalimat, tidak menghitung |
| NFR-2 | Kendali manusia | Tidak ada perubahan di Jira (tanggal, sprint, link) tanpa persetujuan kedua team lead |
| NFR-3 | Izin | Agen dan UI hanya menampilkan issue yang boleh dibaca pengguna yang melihat; ringkasan kapasitas tim lain ditampilkan sebagai angka agregat tanpa detail issue tertutup |
| NFR-4 | Kinerja | Deal sheet siap dalam kurang dari 60 detik untuk tim dengan riwayat 6 sprint; panel issue tampil dalam kurang dari 2 detik |
| NFR-5 | Keandalan | Setiap putaran negosiasi berjalan sebagai job antrean terpisah dan bisa dilanjutkan jika gagal; status negosiasi tersimpan di Forge SQL |
| NFR-6 | Batas platform | Tidak ada fungsi yang melewati batas waktu eksekusi Forge; pemrosesan dipecah per tim dan per sprint |
| NFR-7 | Jejak audit | Setiap opsi, persetujuan, penolakan, dan perubahan kontrak tercatat dengan waktu dan pelakunya |
| NFR-8 | Privasi data | Data tetap di infrastruktur Atlassian jika LLM bawaan Forge tersedia; jika memakai LLM eksternal, hanya ringkasan yang dikirim dan hal ini diungkapkan di listing Marketplace |
| NFR-9 | Aksesibilitas | Komponen Atlaskit, navigasi keyboard, status tidak hanya dibedakan lewat warna |
| NFR-10 | Bahasa | Antarmuka dan prompt agen dalam bahasa Inggris untuk submission |

## Aturan bisnis

Semua keputusan numerik diambil oleh aturan di bagian ini, bukan oleh LLM; agen hanya menjelaskan dan berargumen di atas hasilnya.

### Piagam tim

Piagam ditulis tim sendiri di halaman Confluence dengan template Accord.

| Field | Contoh | Fungsi |
| --- | --- | --- |
| Prioritas kuartal | 1. Holiday release, 2. Ledger migration | Urutan goal yang dipakai untuk menimbang permintaan dan pekerjaan yang digeser |
| Garis merah | Label `security`, issue type Incident | Pekerjaan yang tidak pernah boleh digeser |
| Pekerjaan yang boleh digeser | Prioritas Low dan Medium, label `tech-debt` | Kandidat penggeseran |
| Porsi maksimal untuk tim lain | 25% kapasitas per sprint | Batas atas pekerjaan dari permintaan dependensi |
| Waktu respons | 2 hari kerja | Setelah lewat, permintaan otomatis diingatkan |
| Penyetuju | Team lead | Orang yang menyetujui deal sheet atas nama tim |

### Kapasitas dan ukuran

- **Kapasitas** dihitung dari jumlah issue yang selesai per sprint pada 6 sprint terakhir. Nilai realistis memakai median, nilai pesimis memakai sprint terendah kedua.
- **Komitmen yang ada** adalah issue di sprint aktif dan sprint berikutnya, ditambah issue dengan due date sebelum tanggal yang diminta.
- **Ukuran permintaan** diisi peminta sebagai S, M, atau L (dipetakan ke 1, 3, dan 6 issue), dan bisa dikoreksi penyedia. Peminta juga bisa menandai bagian minimum yang sudah cukup (dipakai untuk opsi sebagian).

### Biaya keterlambatan

Setiap permintaan dan setiap pekerjaan yang mungkin digeser diberi kelas biaya keterlambatan, mengikuti klasifikasi yang umum dipakai di Kanban:

| Kelas | Kapan dipakai | Bobot |
| --- | --- | --- |
| Fixed date | Terkait rilis bertanggal, kontrak, atau regulasi | Tinggi |
| Standard | Terkait goal kuartal yang aktif | Sedang |
| Intangible | Tidak terkait goal aktif (misalnya tech debt) | Rendah |

Kelas diturunkan dari goal atau epic yang tertaut, bukan dari klaim peminta.

### Pembentukan opsi

1. **Tepat waktu tanpa penggeseran:** jika kapasitas pesimis yang tersisa sebelum tanggal yang diminta mencukupi.
2. **Tepat waktu dengan penggeseran:** geser pekerjaan yang boleh digeser, mulai dari kelas biaya terendah dan ukuran terkecil, sampai cukup. Garis merah tidak pernah disentuh.
3. **Sebagian:** jika peminta menandai bagian minimum, bagian itu tepat waktu dan sisanya di tanggal paling awal tanpa penggeseran.
4. **Lebih lambat:** tanggal paling awal tanpa penggeseran apa pun.
5. **Tolak:** jika melebihi porsi maksimal untuk tim lain atau bertentangan dengan garis merah, dengan alasan dari piagam.

Opsi diurutkan berdasarkan apakah memenuhi kebutuhan peminta, lalu berdasarkan biaya keterlambatan pekerjaan yang digeser (semakin rendah semakin baik). Maksimal empat opsi ditampilkan.

### Protokol negosiasi

- **Putaran 1:** Delegate penyedia mengajukan opsi. Delegate peminta menilai opsi terhadap kebutuhan timnya dan boleh meminta satu variasi (misalnya "bisakah bagian minimum dua hari lebih awal?"), yang dihitung ulang oleh perencana.
- **Putaran 2:** Broker menyusun deal sheet dengan satu rekomendasi dan alternatif.
- **Batas:** maksimal dua putaran, setelah itu keputusan pindah ke manusia.
- **Tanpa kesepakatan:** jika salah satu team lead menolak semua opsi, permintaan bisa dieskalasi.

### Pemantauan kontrak

Setiap hari, proyeksi penyelesaian dihitung dari sisa issue dibagi throughput pesimis. Jika proyeksi melewati tanggal kontrak, status berubah menjadi **berisiko** dan kedua team lead diberi tahu. Jika negosiasi ulang aktif (P1), opsi baru langsung disusun.

## Permukaan UI dan pengalaman pengguna

Deal sheet adalah layar terpenting di seluruh produk: di sinilah dua team lead memutuskan, jadi layar ini harus bisa dipahami dalam 30 detik tanpa penjelasan.

| Permukaan | Produk | Pengguna | Isi utama |
| --- | --- | --- | --- |
| Panel Accord | Jira (issue panel) | Kedua team lead | Form permintaan, status (Bernegosiasi, Menunggu persetujuan, Terkontrak, Berisiko), dan link ke deal sheet |
| Deal sheet | Jira (modal dari panel) | Kedua team lead | Kartu opsi berdampingan; untuk setiap opsi: tanggal (rentang), pekerjaan yang digeser, konsekuensi untuk tim peminta dan penyedia, aturan piagam yang dipakai. Lencana "Recommended", tombol Setujui dan Tolak untuk masing-masing pihak, dan penjelasan langkah demi langkah yang bisa dibuka |
| Kotak masuk tim | Jira (global page, tab) | Team lead penyedia | Permintaan masuk, tenggat respons, kontrak aktif yang sedang dikerjakan untuk tim lain |
| Jaringan dependensi | Jira (global page, tab) | Engineering manager | Tim sebagai simpul, kontrak sebagai sisi, kontrak berisiko berwarna peringatan (P1) |
| Piagam tim | Confluence (template + byline) | Team lead penyedia | Template piagam dan status validasi ("Charter valid" atau field yang kurang) |
| Percakapan Rovo | Rovo | Semua | Pertanyaan bebas, misalnya *"What do we owe other teams this sprint?"* atau *"Ask Payments for a refund API by Dec 10"* |

Prinsip pengalaman:

- **Konsekuensi untuk kedua pihak selalu terlihat.** Setiap opsi menampilkan apa artinya bagi peminta dan bagi penyedia, dalam satu kartu.
- **Angka selalu bisa ditelusuri.** Mengklik angka mana pun membuka sumber datanya (sprint, issue, piagam).
- **Bahasa netral.** Agen menulis "opsi ini menggeser Ledger cleanup satu sprint", bukan "Payments harus mengalah".
- **Tidak ada kejutan.** Sebelum persetujuan, ringkasan menampilkan semua perubahan yang akan terjadi di Jira.
- **Komponen Atlaskit** agar terlihat seperti bagian asli Jira.

## Metrik keberhasilan

Ada dua jenis ukuran: metrik produk untuk penggunaan nyata setelah kompetisi, dan kriteria juri untuk submission Codegeist.

### Metrik produk

Target di bawah adalah hipotesis awal yang perlu divalidasi dengan pengguna nyata, bukan janji.

| Metrik | Definisi | Target awal (hipotesis) |
| --- | --- | --- |
| Waktu menuju kesepakatan | Dari permintaan diajukan sampai kedua pihak menyetujui | Median kurang dari 1 hari kerja |
| Kesepakatan tanpa rapat | Persentase permintaan yang disepakati tanpa eskalasi | Di atas 70% |
| Kontrak yang ditepati | Persentase kontrak selesai sebelum atau pada tanggal kontrak | Di atas 80% |
| Waktu peringatan dini | Jarak antara status berisiko pertama dan tanggal kontrak | Median lebih dari 5 hari kerja |
| Adopsi piagam | Persentase tim aktif yang punya piagam valid | Di atas 60% dalam satu bulan |

### Pemetaan ke kriteria juri

Kelima kriteria berbobot sama (masing-masing 20%).

| Kriteria | Bagaimana Accord menjawabnya |
| --- | --- |
| Implementasi teknis | Perencana deterministik + agen multi-peran, Teamwork Graph baca dan tulis, MCP, antrean, Forge SQL; LLM dipisahkan dari perhitungan |
| Desain | Satu layar deal sheet yang menampilkan konsekuensi untuk kedua tim, angka yang bisa ditelusuri, komponen Atlaskit |
| Dampak | Menyerang penyebab keterlambatan yang paling umum di organisasi multi-tim; hasilnya langsung berupa komitmen di Jira |
| Inovasi | Agen yang bernegosiasi atas nama tim berdasarkan piagam yang ditulis tim sendiri; belum ditemukan di Marketplace (perlu diverifikasi) |
| Presentasi | Satu cerita dua tim, dua agen, satu deal sheet, satu peringatan dini; inti selesai di menit ke-3 |

## Cakupan rilis

MVP untuk Codegeist adalah alur lengkap untuk dua tim dan satu permintaan; semua yang lain ditunda sampai alur itu mulus di situs juri.

| Tahap | Isi | Kebutuhan |
| --- | --- | --- |
| **MVP Codegeist (wajib)** | Piagam tim, permintaan dari issue, kapasitas dan komitmen, perencana opsi, negosiasi dua putaran, deal sheet, persetujuan dua pihak, kontrak di Jira, pemantauan harian, agen Delegate dan Broker, relasi ke Teamwork Graph, demo data | FR-1 sampai FR-13 |
| **Jika waktu cukup** | Negosiasi ulang otomatis, eskalasi, saran dari link "blocked by", peta jaringan dependensi, tool MCP | FR-14 sampai FR-18 |
| **Setelah kompetisi** | Analitik kontrak, negosiasi lebih dari dua tim, integrasi dengan Jira Plans | FR-19, FR-20 |

Urutan pemotongan jika waktu sempit: MCP lebih dulu, lalu peta jaringan, lalu saran dari link. Negosiasi ulang dan eskalasi dipertahankan selama mungkin karena keduanya muncul di video.

### Demo data

Tanggal pembuatan issue tidak bisa diisi mundur lewat API, jadi riwayat throughput tidak bisa dipalsukan dari tanggal issue. Generator demo membuat dua tim (*Mobile* dan *Payments*) dengan sprint yang sudah selesai dan diisi issue sekarang, lalu menyimpan throughput historis skenario di Forge SQL dengan label **Simulated history**. Bagian yang terjadi selama demo (permintaan, negosiasi, kontrak, dan peringatan setelah tombol "Add two critical bugs to Payments") berjalan sungguhan.

## Ketergantungan teknologi dan pemetaan bonus

Accord memakai Jira dan Confluence sebagai produk inti, ditambah Rovo, Teamwork Graph, dan MCP; Bitbucket tidak dibutuhkan.

| Kebutuhan | Teknologi Forge | Catatan |
| --- | --- | --- |
| Panel, deal sheet, kotak masuk, jaringan | `jira:issuePanel`, `jira:globalPage`, Custom UI + Atlaskit |  |
| Template dan validasi piagam | Modul Confluence (byline item) + pembacaan halaman |  |
| Perencana, negosiasi, pemantauan | Fungsi Forge, antrean (`consumer`), `scheduledTrigger` harian | Setiap putaran sebagai job terpisah |
| Penyimpanan | Forge SQL | Permintaan, opsi, putaran, kontrak, jejak audit |
| Agen | `rovo:agent` (Team Delegate, Broker) + action reusable | Cek dukungan assignable agent |
| Struktur tim dan atasan bersama | Teamwork Graph (baca) | Cek ketersediaan data Atlassian Teams di developer site |
| Relasi `agreed-dependency` | Teamwork Graph (tulis) | Fallback: Forge SQL |
| Permintaan dari agen eksternal | `rovo:mcp` | P1 |
| Penyusunan kalimat agen | LLM (Forge bawaan, Rovo, atau eksternal) | Tidak dipakai untuk perhitungan |

### Bonus yang dibidik

| Bonus | Bukti | Prioritas |
| --- | --- | --- |
| Best Agents – Rovo/Assignable agents | Dua peran agen yang bernegosiasi, action reusable yang bisa dipanggil agen lain | Utama |
| Best apps with Teamwork Graph integration | Membaca struktur tim dan atasan bersama, menulis relasi kesepakatan | Cadangan |
| Best app with Atlassian MCP | Tool permintaan dan pengecekan kontrak untuk agen eksternal | Cadangan (jika FR-18 selesai) |
| Best Marketplace published app | Listing dikirim paling lambat 10 Desember | Cadangan |

Ingat bahwa satu submission hanya bisa memenangkan satu bonus. Jika Anda juga mengirim Hindsight atau Unjam yang sama-sama membidik bonus Rovo, pertimbangkan menjadikan Teamwork Graph sebagai bonus utama Accord.

### Yang perlu diverifikasi di minggu pertama

- [ ] Apakah satu definisi agen bisa bertindak atas nama tim yang berbeda lewat input action, atau perlu agen terpisah per peran
- [ ] Apakah agen bisa memanggil action agen lain secara langsung, atau negosiasi diorkestrasi oleh fungsi Forge
- [ ] Data Atlassian Teams dan hierarki atasan di Teamwork Graph
- [ ] Skema modul `rovo:mcp`

## Risiko, asumsi, dan pertanyaan terbuka

Risiko terbesar bukan teknis, tetapi kepercayaan: jika team lead penyedia merasa Accord dipakai untuk menekan timnya, produk ini gagal meskipun algoritmanya benar.

### Risiko

| Risiko | Dampak | Mitigasi |
| --- | --- | --- |
| Team lead merasa "AI mengatur tim saya" | Piagam tidak ditulis, opsi diabaikan | Piagam ditulis tim sendiri, hak tolak selalu ada, tidak ada perubahan tanpa persetujuan |
| Data throughput tidak representatif (tim baru, ukuran issue tidak konsisten) | Opsi tidak realistis | Tampilkan rentang, tandai "data terbatas" jika riwayat kurang dari 4 sprint, penyedia bisa mengoreksi ukuran |
| Peminta menggelembungkan urgensi | Penggeseran yang tidak adil | Kelas biaya keterlambatan diturunkan dari goal dan epic, bukan dari input peminta |
| Agen bernegosiasi tanpa ujung atau keluar dari data | Hasil tidak bisa dipercaya | Maksimal dua putaran, angka hanya dari perencana, prompt melarang angka yang tidak berasal dari action |
| Agen tidak bisa memanggil agen lain secara langsung | Negosiasi tidak berjalan sebagai "antar-agen" | Orkestrasi lewat fungsi Forge yang memanggil action setiap peran secara bergantian; tampilkan setiap putaran di UI |
| Data Atlassian Teams kosong di developer site | Eskalasi dan peta tim tidak berfungsi | Demo data membuat tim; cadangan: tim diturunkan dari project Jira |
| Cakupan terlalu besar untuk sisa waktu | Submission setengah jadi | Urutan pemotongan di bagian Cakupan rilis; gate di akhir minggu 1 dan minggu 6 |
| Aplikasi serupa sudah ada | Nilai Innovation turun | Cek Marketplace di minggu 1 |

### Asumsi

- Tim yang memakai Accord bekerja dengan sprint di Jira dan punya riwayat minimal 4 sprint.
- Setiap tim punya satu team lead yang berwenang menyetujui atas nama tim.
- Goal atau epic yang terkait sebuah permintaan tercatat di Jira atau Atlassian Goals.

### Pertanyaan terbuka

1. Apakah tim Kanban tanpa sprint perlu didukung di MVP, atau cukup tim Scrum dulu?
2. Bagaimana menangani permintaan ke tim yang belum punya piagam: tolak, atau pakai piagam default?
3. Apakah atasan bersama boleh memutuskan langsung di deal sheet saat eskalasi, atau hanya memberi rekomendasi?
4. Apakah kontrak perlu tanda tangan ulang jika scope permintaan berubah di tengah jalan?

## Lini waktu

Semua kebutuhan P0 selesai pada 29 November; minggu kelima untuk memoles agen dan mengerjakan P1, dan dua minggu terakhir hanya untuk kesiapan juri dan video.

&#91;embedded content: lini waktu 7 minggu · 2 gate\]

Jika gate pertama gagal karena agen tidak bisa memanggil agen lain, negosiasi tetap dijalankan lewat orkestrasi fungsi Forge. Cerita di video tidak berubah, karena setiap putaran tetap ditampilkan sebagai percakapan antar-agen.
