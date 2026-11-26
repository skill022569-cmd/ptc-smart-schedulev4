# PTC Smart Schedule V4 (`ptc-smart-schedulev4`)

ระบบจัดตารางเรียน–ตารางสอนอัตโนมัติฉบับปรับปรุง (Public / Practice Edition) ตามเอกสารโครงสร้างระบบ **PTC Smart Schedule**

> **หมายเหตุบัญชีและโหมดใช้งาน:**  
> - GitHub & Database (`ptc_smart_schedulev4`) ใช้บัญชี `skill02_2569@pticec.ac.th` (`skill022569-cmd`)  
> - โหมดซ้อม/สาธารณะ (`PUBLIC_DEMO_MODE=true`, `CORS_ORIGIN=*`) — อย่าวางไฟล์ `.env` หรือรหัสผ่านจริงขึ้น Git

---

## โครงสร้าง Monorepo (`pnpm` Workspace)

- `packages/shared` (`@ptc/shared`): Type กลางของทั้ง 30 ตาราง, 7 CSV Dataset, Data Check Issue, Scenario, และ XAI Explanation
- `apps/server` (`@ptc/server`): Drizzle ORM (`mysql-core`) 30 ตาราง, ตัวเชื่อม TiDB Serverless (TLS) / MySQL 8, ตัวนำเข้า 7 CSV + Column Mapping + Data Check Validator, ตัวสร้างและ Seed ชุดข้อมูล Q01/Q21
- `apps/web` (`@ptc/web`): พื้นที่หน้าเว็บ React + Vite (จะพัฒนาในเฟส 5)
- `scenarios/`: ชุดข้อมูลทดสอบ `Q01.json` (1 แผนก / 4 กลุ่ม / 8 ครู / 6 ห้อง) และ `Q21.json` (10 แผนก / 60 กลุ่ม / 120 ครู / 70 ห้อง)
- `drizzle/`: ไฟล์ SQL Migration ที่สร้างด้วย `drizzle-kit`
- `tests/`: Unit Test และ Integration Test ตรวจ Phase 1 (`tests/phase1.test.ts`)

---

## การติดตั้งและตั้งค่าฐานข้อมูล (`ptc_smart_schedulev4`)

### 1. ติดตั้ง Dependencies
*(บน Windows PowerShell ให้ใช้ `pnpm.cmd` หากระบบบล็อกไฟล์ `.ps1`)*

```powershell
pnpm.cmd install
```

### 2. ตั้งค่าไฟล์ `.env`
คัดลอก `.env.example` เป็น `.env` ที่โฟลเดอร์ราก:

```powershell
Copy-Item .env.example .env
```

#### ตัวเลือก A: ใช้ **TiDB Serverless** (แนะนำสำหรับทดสอบออนไลน์, ใช้บัญชี `skill02_2569@pticec.ac.th`)
สร้าง Cluster และ Database ชื่อ `ptc_smart_schedulev4` บน [TiDB Cloud](https://tidbcloud.com) แล้วใส่ค่าใน `.env`:

```env
DATABASE_URL=mysql://<user>:<password>@gateway01.<region>.prod.aws.tidbcloud.com:4000/ptc_smart_schedulev4
DB_SSL=true
```

#### ตัวเลือก B: ใช้ **Docker MySQL 8** บนเครื่อง

```powershell
docker compose up -d
```

ใช้ค่าเริ่มต้นจาก `.env.example`:

```env
DATABASE_URL=mysql://root:ptc1234@127.0.0.1:3306/ptc_smart_schedulev4
DB_SSL=false
```

---

## คำสั่งที่ใช้ตรวจและรันงาน (Phase 1)

```powershell
# 1. สร้างชุดข้อมูลทดสอบ Q01.json และ Q21.json
pnpm.cmd gen:scenarios

# 2. สร้างไฟล์ SQL Migration จาก Drizzle Schema 30 ตาราง
pnpm.cmd db:generate

# 3. Push ตารางขึ้นฐานข้อมูล TiDB Serverless หรือ MySQL 8 (ต้องตั้งค่า .env ก่อน)
pnpm.cmd db:push

# 4. Seed ข้อมูลทดสอบ Q21 หรือ Q01 ลงฐานข้อมูล
pnpm.cmd seed -- --scenario Q21
# หรือ: pnpm.cmd seed -- --scenario Q01

# 5. ตรวจสอบ TypeScript ทั้ง Monorepo และไฟล์ tests/
pnpm.cmd typecheck
pnpm.cmd exec tsc --noEmit -p tsconfig.json

# 6. รัน Unit Test (30 tests)
pnpm.cmd test
```

---

## บัญชีทดสอบ (Demo / Public Practice Accounts)

เมื่อรัน `seed.ts` ระบบจะสร้างบัญชีทดสอบทั้ง 5 Role (รหัสผ่านคือ `<role>1234`):

| Username | Role | Password (Demo) |
|---|---|---|
| `admin` | `admin` | `admin1234` |
| `scheduler` | `scheduler` | `scheduler1234` |
| `teacher` | `teacher` | `teacher1234` |
| `student` | `student` | `student1234` |
| `viewer` | `viewer` | `viewer1234` |
