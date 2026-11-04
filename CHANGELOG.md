# Changelog

Semua perubahan penting dicatat di sini. Format mengikuti Keep a Changelog, versi mengikuti SemVer.

## [Unreleased]

### Added
- Scaffolding Forge app (UI Kit, runtime `nodejs24.x`, TypeScript): manifest dengan issue panel Jira, global page, byline Confluence, consumer antrean negosiasi, monitor harian, Forge SQL, agen Rovo "Accord Team Delegate" dan "Accord Broker", serta enam action Rovo (belum di-deploy; `app.id` masih placeholder sampai `forge register`).
- Skema Forge SQL untuk tim, piagam, throughput, permintaan, putaran negosiasi, opsi, persetujuan, kontrak, relasi dependensi, dan jejak audit.
- Planner deterministik: kapasitas realistis/pesimis dari 6 sprint terakhir, opsi tepat waktu, tepat waktu dengan penggeseran (garis merah tidak pernah digeser), sebagian, lebih lambat, dan tolak berdasarkan porsi maksimal piagam; maksimal 4 opsi berurutan dengan satu rekomendasi.
- Penjelasan opsi dalam bahasa Inggris netral yang setiap angkanya berasal dari jejak perhitungan, plus konsekuensi untuk tim peminta dan penyedia.
- Variasi "bagian minimum lebih awal N hari" untuk putaran negosiasi.
- Skenario demo Mobile/Payments dengan riwayat throughput simulasi; action `evaluate-options` sementara memakai skenario ini.
- Data layer Jira (board Scrum, sprint, issue sprint, pencarian JQL, bulk create) dan Confluence (space, halaman v2, label) via `asApp`/`asUser`.
- Piagam tim: generator template storage format (heading h2 per field), parser, dan validator yang mengembalikan field yang kurang; hasil disimpan di tabel `charters`.
- Kapasitas & komitmen: sampel throughput dari sprint Jira yang selesai (atau Simulated history), komitmen sprint aktif + berikutnya + issue ber-due date.
- Generator demo data bertahap & idempoten: project MOB/PAY dengan board Scrum, sprint aktif + berikutnya berisi issue, halaman piagam berlabel `accord-charter`, dan 6 sprint throughput simulasi per tim.
- Global page: tab Teams (status piagam, rentang kapasitas, lencana "Simulated history"/"Limited data", tombol "Create charter page"), tab Demo (seed dengan konfirmasi dan status per langkah); byline Confluence menampilkan "Charter valid" atau field yang kurang.
- Web trigger diagnostik khusus development (`accord-dev-diag`); hasil spike M0 di `docs/spikes.md`.

### Fixed
- Byline "Accord charter" di Confluence menampilkan "Unknown SQL execution error": byline kini memvalidasi halaman piagam langsung dari isi halaman tanpa Forge SQL (database instalasi Confluence terpisah dari Jira), dan error resolver dicatat ke `forge logs`.
- Push ke queue Forge (`accord-negotiation`, `accord-demo-seed`) selalu `400 Bad Request`: modul `consumer` kini memakai format `@forge/events` v2+ (`function`, bukan `resolver`) dan consumer membaca `event.body` dari `AsyncEvent`.

### Changed
- Scope tambahan Jira/Confluence untuk Agile API, pembuatan project, space, dan label.
