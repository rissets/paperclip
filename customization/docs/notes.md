r
```
Enterprise Data Layer
        +
Knowledge Layer
        +
Semantic Layer
        +
MCP / Tool Layer
        +
Agent Runtime
        +
Agent Builder
        +
Governance & Security
        +
Observability

```

|Source|Storage/ingestion utama|Agent mengakses melalui|
|---|---|---|
|PDF/DOC/TXT/MD|Object Store + RAG Index|Retrieval Service|
|Excel/CSV|Database/Warehouse|SQL/Data Agent|
|Google Sheets|Database/Warehouse|SQL/Data Agent|
|Existing Database|Native DB connection / replica|SQL Tool/MCP|
|REST/GraphQL API|Connector + optional ingestion|MCP tools|
|SaaS|Existing connector/Airbyte|SQL/MCP|
|MQTT/IoT|MQTT consumer → stream → DB|SQL/MCP|
|CCTV|ONVIF/RTSP → video pipeline|Video Search/MCP|
|Images|Object storage + metadata/vector|Multimodal Retrieval|
|Audio|Object storage + transcription|Retrieval|
|Email/Chat|Connector → structured + text index|SQL + RAG|
|Events/Webhooks|Event Gateway → queue/stream|DB/event tools|

## Arsitektur CSV/Excel/Sheets
Platform seperti Snowflake juga menggunakan **text-to-SQL + semantic model** untuk conversational analytics atas structured data. Semantic layer mendeskripsikan entities, dimensions, metrics, joins, synonyms dan verified queries agar SQL yang dibuat LLM jauh lebih akurat. strategi menggunakan pendekatan **hybrid structured + semantic**.

**research snowflake alternatif opensource ?**

CSV / Excel / Google Sheets
             │
             ↓
        Profiling
             ↓
      Schema Inference
             ↓
 Data Type Normalization
             ↓
     Entity Detection
             ↓
        PostgreSQL
        / Warehouse
             ↓
      Semantic Model
             ↓
          SQL Agent

### Semantic Layer perlu menjadi komponen first-class
Misalnya database:

```
orders
customers
products
order_items
```

Schema database saja belum cukup memberi tahu LLM:

```
Revenue =
SUM(order_items.qty * order_items.net_price)

Active Customer =
customer yang transaksi dalam 90 hari

AOV =
Revenue / distinct orders
```

Maka setiap dataset perlu sebuah **Semantic Model**.

Contohnya:

```
entities:
  - customer
  - order
  - product

dimensions:
  - order_date
  - region
  - product_category

metrics:
  revenue:
    expression: sum(quantity * net_price)

  average_order_value:
    expression: revenue / count_distinct(order_id)

relationships:
  orders.customer_id -> customers.id
  order_items.order_id -> orders.id

synonyms:
  revenue:
    - pendapatan
    - omzet
    - sales value
```

Snowflake menjelaskan alasan yang sama: schema fisik sering tidak mempunyai business definitions, metric logic, atau relationships yang cukup untuk text-to-SQL yang akurat.

Tambahkan juga:

```
Verified Question
        +
Verified SQL
```

Contoh:

```
"Berapa revenue bulan ini?"

→ validated SQL
```

Verified query repository merupakan salah satu pola yang digunakan untuk meningkatkan trustworthiness text-to-SQL.

## RAG

```
PDF
DOCX
TXT
Markdown
HTML
SOP
Policy
Contract
Manual
Proposal
Knowledge base
```

gunakan:

```
Raw Document
     ↓
Parser
     ↓
Structure Extraction
     ↓
Metadata Extraction
     ↓
Chunking
     ↓
Embedding
     ↓
Vector + Lexical Index
```

Saya sarankan pipeline:

```
                     USER QUESTION
                          │
                    Query Analyzer
                          │
             ┌────────────┴────────────┐
             │                         │
       Dense Retrieval           Sparse/BM25
             │                         │
             └────────────┬────────────┘
                          │
                      Fusion
                          │
                    Candidate K
                          │
                      Reranker
                          │
                  ACL / metadata
                          │
                    Context Builder
                          │
                         LLM
                          │
              Answer + Source Citation
```

**Hybrid dense+sparse retrieval** diikuti reranking adalah pola yang sangat kuat. **Qdrant** misalnya mendokumentasikan retrieval dengan dense embeddings + sparse/BM25 lalu late-interaction reranking; reranker diterapkan ke candidate set kecil agar precision naik tanpa membayar latency atas seluruh corpus.

pgvector juga bisa menjalankan vector similarity bersama PostgreSQL full-text search untuk hybrid search.

Untuk tahap awal saya justru menyarankan:

```
PostgreSQL
   +
pgvector
   +
PostgreSQL FTS
```

daripada langsung memasang lima database.

Jika data vector sudah sangat besar, baru pertimbangkan:

```
Qdrant
OpenSearch
Weaviate
Milvus
```

Databricks juga membedakan structured dan unstructured data dalam RAG architecture dan menekankan ingestion, retrieval, evaluation/monitoring serta governance sebagai bagian lifecycle RAG.

### **Butuh RAG Agent ?**

Ia menangani:

```
files
 ↓
classification
 ↓
parser selection
 ↓
metadata
 ↓
chunk strategy
 ↓
embedding strategy
 ↓
index creation
 ↓
retrieval evaluation
```

### Saat runtime: RAG sebaiknya bukan agent utama

Jadikan:

**Retrieval Service / Knowledge Skill**

Kemudian Knowledge Agent boleh menggunakan service tersebut.

```
Knowledge Agent
      │
      └── retrieve(query)
              ↓
         Retrieval Service
```

Dengan begitu retrieval deterministik dan reusable oleh:

```
Research Agent
SQL Agent
Prediction Agent
General Agent
Builder Agent
```


## Existing database: MCP atau direct DB?

**keduanya, tetapi di layer berbeda.**

Database fisik:

```
PostgreSQL
MySQL
SQL Server
Oracle
MongoDB
...
```

dihubungkan menggunakan **native database driver/pool**.

Contoh konseptual:

```
Agent
  ↓
MCP / Data Query Tool
  ↓
Data Access Service
  ↓
Native DB Driver
  ↓
Database
```

MCP adalah **agent-facing interface**.

Bahkan reference MCP sebelumnya mencantumkan PostgreSQL server yang memberi read-only database access dan schema inspection sebagai contoh.

Untuk enterprise saya akan menyediakan tools seperti:

```
inspect_schema()
search_semantic_model()
generate_query()
execute_readonly_query()
explain_query()
```


## API / SaaS

Sebelum MCP Builder membuat sesuatu, lakukan:

```
Connector Discovery
        ↓
Is existing connector available?
       / \
     YES  NO
     ↓     ↓
 reuse   build
```

Airbyte sekarang mendokumentasikan ratusan connector untuk API, files, databases, warehouses dan source/destination systems serta menyediakan Connector Builder/CDK.

Jadi MCP Builder Agent harus bertanya secara internal:

```
1. Sudah ada connector?
2. Sudah ada MCP?
3. Ada OpenAPI spec?
4. Ada SDK resmi?
5. Baru generate custom implementation.
```

Ini menghindari sistem menghasilkan ribuan connector custom yang sulit dipelihara.

Contoh Salesforce:

**Data replication**
```
Salesforce
   ↓
Airbyte Connector
   ↓
Warehouse
```

**Real-time action**
```
Agent
 ↓
Salesforce MCP
 ↓
Salesforce API
```

Misalnya user:
> tampilkan total penjualan 12 bulan terakhir.

Lebih efisien menggunakan warehouse.

Tetapi:
> buat lead baru di Salesforce.

harus lewat tool/API/MCP.

Jadi satu source dapat memiliki **dua integration mode**:

```
Data Plane       → ingestion/replication
Action Plane     → MCP/tool/API
```


---


## MQTT / IoT

MQTT memang protokol lightweight publish/subscribe yang dirancang untuk M2M dan IoT. Client dapat subscribe terhadap topic dan broker mengirim message yang cocok dengan subscription.

Maka arsitekturnya:

```
IoT Device
    ↓
MQTT Broker
    ↓
IoT Ingestion Service
    ↓
Normalizer
    ↓
Event Stream
    ↓
Time-Series / Analytical DB
    ↓
SQL/Data Agent
```

Sedangkan MCP:

```
Agent
 ↓
IoT MCP
 ↓
get_device()
get_status()
get_latest_metric()
set_device_mode()
restart_device()
```

### MCP Builder untuk IoT

`MCP Builder Agent` menerima:

```
MQTT broker URL
topic patterns
credentials
payload examples
device schema
```

Kemudian builder membuat **integration package**, bukan sekadar MCP.

Output:

```
IoT Integration Package
│
├── MQTT Subscriber Service
├── Topic configuration
├── Payload schema
├── Normalizer
├── Database schema
├── Storage writer
├── MCP Server
├── Health checks
├── Tests
├── Permissions
└── Deployment manifest
```

Contohnya:

```
factory/+/temperature
factory/+/humidity
factory/+/status
```

Agent mendeteksi:

```
device_id
timestamp
temperature
humidity
status
```

lalu membuat:

```
iot_measurements
---------------
tenant_id
device_id
metric
value
timestamp
```

Baru MCP expose:

```
get_device_metrics()
get_latest_reading()
find_abnormal_devices()
```


## CCTV

```
IP Camera
    │
    ├── ONVIF ── control / metadata / events
    │
    └── RTSP ─── video stream
                 ↓
          Video Ingestion
                 ↓
        Video Analytics
        / Vision Model
                 ↓
      events / objects / clips
          ↓              ↓
     Metadata DB     Object Storage
          ↓              ↓
        Vector / multimodal index
                 ↓
                Agent
```

ONVIF Profile T mencakup IP-video streaming, H.264/H.265, motion/tampering events, metadata streaming serta PTZ support. RTSP digunakan untuk memulai streaming session.

MCP CCTV jangan mengirim continuous video stream ke LLM.

Expose tool seperti:

```
list_cameras()
camera_status()
search_events()
get_snapshot()
get_clip()
search_person_event()
search_vehicle_event()
move_ptz()
```

`move_ptz()` memiliki privilege jauh lebih tinggi daripada `search_events()`.

## Agent untuk ONBOARDING

```
              Onboarding Orchestrator
                       │
      ┌────────────────┼─────────────────┐
      │                │                 │
      ↓                ↓                 ↓
Discovery         Structured       Knowledge
Agent             Ingestion        Ingestion
      │                │                 │
      └────────────────┼─────────────────┘
                       ↓
                 Semantic Model
                      Agent
                       │
        ┌──────────────┴───────────────┐
        ↓                              ↓
 Connector/MCP Builder          Quality Agent
        │                              │
        └──────────────┬───────────────┘
                       ↓
                Validation Agent
                       ↓
                    Publish
```

Tanggung jawabnya:

|Onboarding Agent|Fungsi|
|---|---|
|**Onboarding Orchestrator**|Menentukan workflow onboarding|
|**Source Discovery Agent**|Mengenali source, schema, format dan capability|
|**Structured Ingestion Agent**|CSV/Excel/Sheets/API/database → structured store|
|**Knowledge Ingestion Agent**|Docs → parse/chunk/embed/index|
|**Semantic Modeling Agent**|Membentuk entities, dimensions, metrics, relationships|
|**Connector/MCP Builder Agent**|Membuat connector/MCP bila dibutuhkan|
|**Data Quality Agent**|Profiling, null/duplicate/anomaly/schema validation|
|**Validation/Evaluation Agent**|Uji RAG, SQL, MCP, ACL, permissions sebelum publish|

### Source Discovery Agent

Ini agent pertama setelah source ditambahkan.

Input:

```
source_id
connection info
sample
metadata
```

Output terstruktur:

```
{
  "source_type": "structured_file",
  "format": "xlsx",
  "recommended_strategy": "database_ingestion",
  "contains_multiple_tables": true,
  "contains_free_text": true,
  "requires_rag": false,
  "requires_semantic_model": true
}
```

Dengan demikian routing tidak hardcoded per extension.

---

### Structured Ingestion Agent

Tanggung jawab:

```
CSV
Excel
Google Sheets
JSON tabular
API datasets
```

Workflow:

```
Read
 ↓
Profile
 ↓
Infer schema
 ↓
Detect primary key
 ↓
Detect relationships
 ↓
Normalize
 ↓
Generate staging schema
 ↓
Load
 ↓
Validate
 ↓
Promote
```

Gunakan:

```
raw
 ↓
staging
 ↓
canonical
```

---

### Knowledge Ingestion Agent

Tanggung jawab:

```
document parsing
classification
deduplication
metadata
chunking
embedding
indexing
retrieval testing
```

Ia juga harus menyimpan provenance:

```
chunk
 ↓
document_version
 ↓
source
 ↓
tenant
```

Sehingga semua jawaban bisa kembali ke sumber aslinya.

### Semantic Modeling Agent

Menurut saya agent ini **wajib ditambahkan**.

Setelah SQL ingestion:

```
tables
 ↓
column profile
 ↓
relationships
 ↓
business concepts
 ↓
semantic model
```

Ia bisa menghasilkan draft:

```
entities
dimensions
facts
metrics
relationships
synonyms
sample questions
verified SQL
```

Tetapi definisi KPI penting tetap sebaiknya bisa direview manusia.

---

### MCP Builder Agent

MCP Builder harus menghasilkan versioned project.

Misalnya:

```
mcp-salesforce-v3
mcp-production-iot-v2
mcp-cameras-v1
```

Builder workflow:

```
Source
 ↓
Discover protocol/schema
 ↓
Look for existing connector/MCP
 ↓
Generate MCP manifest
 ↓
Generate tools/resources
 ↓
Generate auth adapter
 ↓
Generate code
 ↓
Unit test
 ↓
Integration test
 ↓
Security scan
 ↓
Sandbox deployment
 ↓
Human approval
 ↓
Publish MCP Registry
```

---

## Agent default SETELAH onboarding

**user-facing specialist agents.**

```
                   Supervisor Agent
                         │
     ┌────────┬──────────┼─────────┬──────────┐
     ↓        ↓          ↓         ↓          ↓
 Knowledge   Data     Research   Prediction   Builder
   Agent     Agent      Agent      Agent        Agent
              │
       Visualization
           Agent
              │
          Action Agent
```

|Agent|Tujuan|
|---|---|
|**Supervisor/Enterprise Agent**|Default conversation + orchestrator|
|**Knowledge Agent**|RAG/document grounded answers|
|**Data/SQL Agent**|Structured analytics|
|**Visualization/Engineer Agent**|Chart/diagram/report artifacts|
|**Prediction Agent**|Forecasting, anomaly, predictive modelling|
|**Research Agent**|Internet/external research|
|**Builder Agent**|Membuat agent, skill, MCP, integration|
|**Action Agent**|Menjalankan business actions melalui MCP/tools|

Saya pisahkan Action Agent karena permission-nya berbeda secara fundamental dari analytical agents.

---

### SQL Agent

Agent ini jangan diberi unrestricted database access.

Flow:

```
Question
   ↓
SQL Agent
   ↓
Semantic Catalog
   ↓
Relevant schemas
   ↓
Generate query
   ↓
SQL Validator
   ↓
Policy
   ↓
Readonly Execution
   ↓
Result validation
   ↓
Explanation
```

Agent sebaiknya tidak dikirim schema seluruh enterprise database.

Gunakan retrieval:

```
question
 ↓
semantic model selector
 ↓
relevant 3-10 tables
 ↓
LLM
```

Ini menjaga context dan akurasi.

---

### Visualization / Engineer Agent

Menurut saya ini sangat berguna sebagai default.

Tetapi jangan hanya disebut “chart agent”.

Nama lebih luas:

**Analytics Engineer Agent**

Capability:

```
chart
table
dashboard spec
diagram
statistical analysis
data transformation
Python analysis
report
```

Flow:

```
SQL result
   ↓
Analytics Engineer
   ↓
Determine representation
   │
   ├── table
   ├── line chart
   ├── bar
   ├── scatter
   ├── KPI cards
   ├── heatmap
   └── diagram
```

Agent tidak perlu mengambil data sendiri kalau SQL Agent sudah mengambilnya.

---

### Prediction Agent

Prediction Agent jangan menggunakan LLM untuk menebak angka.

Ia harus menjadi:

```
LLM = planning/controller

ML/statistical model = prediction
```

Flow:

```
User
 ↓
Prediction Agent
 ↓
Understand target
 ↓
SQL/Data retrieval
 ↓
Data quality check
 ↓
Determine problem
 ├── forecasting
 ├── regression
 ├── classification
 └── anomaly detection
 ↓
Feature engineering
 ↓
Candidate models
 ↓
Validation / backtesting
 ↓
Best valid model
 ↓
Prediction
 ↓
Uncertainty / metrics
```

Untuk time series, split datanya harus menghormati urutan waktu; scikit-learn memperingatkan regular random/KFold CV tidak cocok karena bisa menyebabkan future data masuk ke training. `TimeSeriesSplit` disediakan untuk kasus seperti ini.

Model yang sudah dianggap reusable bisa disimpan di **MLflow Model Registry**, yang menyediakan lineage, versions dan lifecycle metadata.

---

### Research Agent

Research Agent:

```
question
 ↓
Search plan
 ↓
Internet search
 ↓
Source collection
 ↓
Source quality/ranking
 ↓
Cross-source verification
 ↓
Synthesis
 ↓
Citations
```

Dan bisa digabung dengan internal knowledge:

```
Internal RAG
      +
Structured company data
      +
External web
```

Contoh:

> Mengapa penjualan produk A turun bulan ini?

Supervisor dapat menjalankan:

```
SQL Agent
    ↓
internal sales evidence

Research Agent
    ↓
external market evidence

Knowledge Agent
    ↓
company campaign/policy/context

          ↓
     Supervisor
          ↓
final synthesis
```

Ini merupakan contoh kasus yang benar-benar layak multi-agent.

---

### Builder Agent

Builder Agent adalah salah satu differentiator paling kuat untuk platform Anda.

Input:

> Buatkan agent inventory yang bisa membaca data gudang dan memberikan warning jika stok kritis.

Builder harus menghasilkan:

```
Agent Definition
├── name
├── description
├── instructions
├── capabilities
├── skills
├── allowed data sources
├── MCP/tools
├── model profile
├── guardrails
├── permission scopes
├── trigger
├── evaluation tests
└── output schema
```

Kemudian:

```
Builder
 ↓
Draft
 ↓
Validate
 ↓
Evaluation
 ↓
Security Review
 ↓
Approval
 ↓
Agent Registry
```

Builder tidak boleh mengubah dirinya sendiri secara langsung.

## Skill Registry
Tambahkan konsep:

```
Skills
```

Contohnya:

```
analyze_sales
forecast_timeseries
summarize_contract
compare_documents
generate_executive_report
inspect_database
research_market
```

Satu agent bisa mempunyai:

```
Agent
 ├── skills
 ├── tools
 ├── MCP servers
 ├── data scopes
 └── policies
```

Dengan demikian Anda tidak perlu membuat:

```
500 jenis agent
```

Cukup:

```
8 core agents
+
hundreds of composable skills
```

Ini jauh lebih scalable.

## Question

- agent orkestratornya seperti apa, harusnya ada main agent yang mengorkestrasi task ke agent agent tertentu yang memiliki capability tersebut, sehingga koneksinya menggunakan agent to agent (A2A)
- research snowflake alternatif opensource untuk arsitektur CSV/Excel/Sheets 
- research arsitektur rag hybrid dense+sparse retrieval dengan PostgreSQL + pgvector + PostgreSQL FTS
- di agent onboarding gimana kalo saat onboarding itu data sourcenya ada banyak ada excel, csv, docs, pdf, database eksternal, api dan sensor iot gimana ?
- untuk agent agent nya ini ada yang butuh code interpreter sandbox, ini belum ada 
