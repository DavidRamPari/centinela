# Centinela

[English](README.md) | **Español**

Centinela es un SIEM pequeño y de código abierto: ingiere logs de autenticación de Linux, logs de acceso de servidores web y eventos de Sysmon de Windows, detecta ataques con 1,245 reglas Sigma y de correlación, y muestra cada alerta mapeada a MITRE ATT&CK con una guía de respuesta en español o en inglés. Corre en una computadora portátil con tres comandos.

![El Resumen: alertas nuevas por severidad y las primeras que conviene revisar](docs/screenshots/overview.png)

![Demostración: el Resumen, la alerta crítica con su línea de tiempo y su guía de respuesta en español, la matriz ATT&CK y una alerta que llega en vivo](docs/screenshots/demo.gif)

<sub>Grabado en la aplicación real con los datos de demostración (41 s). Más capturas en [docs/screenshots](docs/screenshots).</sub>

## Qué es y qué no es

Centinela es un proyecto de aprendizaje que implementa de punta a punta el núcleo de un SIEM: ingesta, normalización de eventos, detección con Sigma y correlación, clasificación de alertas, mapeo a ATT&CK y guías de respuesta bilingües. No compite con Wazuh, Elastic ni Splunk: no tiene agentes, ni clústeres, ni cuentas por analista, y lee tres formatos de log. Lo que busca hacer bien es ser correcto, explicable y seguro frente a datos hostiles, y demostrarlo con pruebas.

## Puntos destacados

**Un motor Sigma escrito desde cero.** Compila las 1,231 reglas de SigmaHQ incluidas en el repositorio y las 14 reglas propias de Centinela ([informe de reglas](docs/rules-report.md)): modificadores de valor desde `contains` hasta `windash`, `base64offset`, `re`, `cidr`, `fieldref` y comparaciones numéricas, la gramática completa de condiciones, el enrutamiento por `logsource` y las correlaciones Sigma (`event_count`, `value_count`, `temporal`, `temporal_ordered`, encadenamiento). No admite el modificador `expand`, las condiciones de agregación, `near` ni las condiciones de rango o ausencia en correlaciones, y marca como no soportada cualquier regla que los use. Las expresiones regulares de las reglas corren en RE2, en tiempo lineal. Con un índice de literales y un prefiltro evalúa **85,255 eventos/s** en una mezcla de Linux y web y **5,956 eventos/s** en creación de procesos de Windows, donde cada evento pasa por 1,193 reglas (un solo hilo, máquina virtual en la nube con 4 vCPU Intel Xeon a 2.10 GHz, Node.js 22.22.0). Diseño, semántica y benchmark: [docs/DETECTION.md](docs/DETECTION.md) (en inglés).

**Calidad de detección medida contra la verdad de referencia.** Un generador con semilla escribe tres días de logs de una empresa ficticia con 19 escenarios de ataque etiquetados (fuerza bruta, password spraying, inyección SQL, sondeos de Log4Shell, una webshell, PowerShell codificado, LOLBins, volcado de credenciales y más). La prueba de punta a punta y `npm run demo` detectan **19/19 escenarios**, y el tráfico de fondo no genera **ninguna alerta alta ni crítica**. Con las muestras de regresión de SigmaHQ: **272 de 276 eventos coinciden y pasan 267 de 267 archivos**, también a través del pipeline completo. Cómo se mide: [docs/DETECTION.md](docs/DETECTION.md#how-detection-quality-is-measured).

**Un paquete de contenido bilingüe.** Todas las reglas de SigmaHQ incluidas salvo diez, y todas las reglas de Centinela, tienen una guía de investigación en español y en inglés (qué detecta, por qué importa, pasos de clasificación, falsos positivos, pasos de respuesta), que se muestra junto a la alerta con la etiqueta "Generada con IA — revísala antes de usarla". Las guías traen eventos de prueba que el motor valida: **pasan 4,843 de 4,851 casos (99.8 %)** para 1,221 reglas de SigmaHQ ([informe](docs/content-pack-report.md)) y **36 de 36** para las reglas de Centinela ([informe](content/centinela-report.md)); `npm test` los conserva como suite de regresión.

**Seguridad desde el diseño.** Las líneas de log las escriben las mismas personas que Centinela vigila, así que el [modelo de amenazas](docs/THREAT_MODEL.md) trata cada campo como hostil:

- _Contenido de log hostil:_ se muestra solo como texto (una regla de lint prohíbe `dangerouslySetInnerHTML`), bajo una Content Security Policy estricta, y se guarda solo con SQL parametrizado.
- _ReDoS:_ las expresiones regulares de las reglas corren en RE2 sobre valores recortados a 8,192 caracteres, las de los parsers están ancladas y sin cuantificadores anidados, y nunca se construye una expresión regular a partir del contenido de un log.
- _Fuerza bruta:_ contraseñas con argon2id, bloqueo por IP tras 5 fallos durante 15 minutos, límites de solicitudes en el inicio de sesión y en la ingesta, y como máximo 4 verificaciones de contraseña simultáneas.
- _CSRF:_ un token de doble envío ligado a la sesión, más cookies `SameSite=Strict`.
- _Direcciones de cliente falsificadas:_ `X-Forwarded-For` solo se acepta de los proxies que indica `TRUST_PROXY`, y `TRUST_PROXY=true` se rechaza.

La guía para operadores es [docs/SECURITY.md](docs/SECURITY.md) (en inglés).

**Prácticas de ingeniería.** TypeScript en modo estricto con zod en cada frontera; 1,342 pruebas en 96 archivos (Vitest, Supertest contra un PostgreSQL real, React Testing Library); CI en cada pull request (lint, typecheck, migraciones, pruebas, build); y un registro de decisiones por cada sesión ([docs/decisions](docs/decisions)).

<!-- Repositorio del dataset: David agrega aquí el enlace al dataset público de guías de respuesta bilingües para todas las carpetas de reglas de SigmaHQ, con sus números. -->

## De una línea de log a una alerta en pantalla

```mermaid
%%{init: {"flowchart": {"rankSpacing": 32, "nodeSpacing": 28}}}%%
flowchart TB
  I["Líneas de log → POST /api/ingest (token bearer, límite de solicitudes)"]
  I --> P["Parser: un evento normalizado por línea"]
  P --> E[("PostgreSQL: eventos")]
  P --> S["Reglas Sigma: enrutamiento por logsource, prefiltro, evaluación"]
  S --> C["Correlación: ventanas en tiempo del evento"]
  S --> A["Receptor de alertas: deduplicación, supresión"]
  C --> A
  A --> DB[("PostgreSQL: alertas")]
  A -->|"flujo en vivo (SSE)"| UI["Panel en español e inglés"]
  DB -->|API REST| UI
  E -->|API REST| UI
```

El mismo pipeline atiende a `npm run ingest` (archivos) y a la carga de archivos del panel. Detalles: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) y [docs/DETECTION.md](docs/DETECTION.md) (en inglés).

## Inicio rápido

Necesitas Node.js 22 ([`.nvmrc`](.nvmrc)) y Docker con Compose v2: Docker Desktop en macOS o en Windows (ejecuta los comandos en una terminal de WSL 2 con la integración de WSL de Docker Desktop activada), o Docker Engine en Linux. Los puertos 5432, 3000 y 8080 deben estar libres en 127.0.0.1.

```bash
git clone https://github.com/DavidRamPari/centinela.git && cd centinela
npm ci                                 # instala los workspaces
docker compose up -d --build --wait    # PostgreSQL, API y panel; termina cuando están sanos
npm run demo                           # tres días de logs de demostración por el pipeline de detección
```

`npm run demo` termina así (desde un clon nuevo, 2026-10-27):

```text
  total: 200280 events, 0 rejected, 37 alerts created, 2 updated in 34.3 s (5847 events/s)
  alerts by level: critical 1, high 17, medium 16, low 3, informational 0
...
detected 19/19 scenarios

Open the dashboard: http://localhost:8080 (docker compose) or http://localhost:5173 (npm run dev).
The default view shows the last 24 hours; pick "Last 7 days" to see every scenario.
Sign in as admin / centinela-dev (development credentials).
```

Abre <http://localhost:8080> e inicia sesión como `admin` con la contraseña `centinela-dev`. El idioma del panel se cambia en la barra lateral (Preferencias). Los datos terminan en la hora actual: elige **Últimos 7 días** para ver todos los escenarios. `--wait` solo termina cuando PostgreSQL y el servidor están sanos (con las migraciones aplicadas), así que nada compite con el arranque de la base de datos.

- Si ejecutas la demostración otra vez, se niega a cargar una segunda copia: `npm run demo -- --reset` reemplaza los datos (conserva qué reglas están activadas).
- Para ver llegar una alerta en vivo, deja el panel abierto y envía doce inicios de sesión SSH fallidos seguidos de uno exitoso desde la misma dirección:

  ```bash
  ts=$(date -u +%Y-%m-%dT%H:%M:%S)
  { for i in $(seq 10 21); do
      echo "$ts.${i}0000+00:00 bastion-01 sshd[70$i]: Failed password for root from 203.0.113.201 port 510$i ssh2"
    done
    echo "$ts.990000+00:00 bastion-01 sshd[7099]: Accepted password for deploy from 203.0.113.201 port 51099 ssh2"
  } | curl -sS -X POST 'http://localhost:8080/api/ingest?source=linux_auth&host=bastion-01' \
        -H 'Authorization: Bearer dev-ingest-token-change-me' -H 'Content-Type: text/plain' --data-binary @-
  ```

  La respuesta indica `"alertsCreated":2`: la fuerza bruta (alta) y el inicio de sesión exitoso posterior (crítica) aparecen como notificaciones.

- Detén el entorno con `docker compose down` (agrega `-v` para borrar el volumen de la base de datos).
- Si un puerto está ocupado, define `POSTGRES_PORT`, `SERVER_PORT` o `WEB_PORT` en un archivo `.env` (copia [`.env.example`](.env.example)); si cambias el puerto de PostgreSQL, ajusta también `DATABASE_URL` para que `npm run demo` lo encuentre.

### Desarrollo

```bash
docker compose up -d --wait postgres   # solo PostgreSQL
npm run db:migrate
npm run dev                            # API en :3000 (modo watch), panel en http://localhost:5173
```

`VITE_USE_MOCKS=true npm run dev -w packages/web` levanta el panel con datos simulados, sin API ni base de datos.

| Script | Qué hace |
| --- | --- |
| `npm run dev` | servidor de la API y servidor de desarrollo de Vite juntos |
| `npm run build` | compila `shared` y luego `server`, `web` y `loggen` |
| `npm test` | Vitest en todos los paquetes (necesita PostgreSQL) |
| `npm run lint` · `npm run typecheck` · `npm run format` | ESLint y revisión de Prettier · `tsc` en cada paquete · Prettier con escritura |
| `npm run db:migrate` | aplica las migraciones pendientes a `DATABASE_URL` |
| `npm run demo [-- --reset]` | genera, ingiere y detecta el conjunto de demostración, y lo contrasta con la verdad de referencia |
| `npm run ingest -- --source <tipo> --host <nombre> --file <ruta>` | ingiere un archivo de log por el pipeline (`linux_auth`, `nginx_access`, `apache_access`, `sysmon`) |
| `npm run loggen -- [--small] [--seed n] [--out dir]` | escribe los logs de demostración y `ground-truth.json` (por defecto en `samples/`) |
| `npm run rules:report` · `npm run bench` | informe de carga de reglas ([docs/rules-report.md](docs/rules-report.md)) · benchmark del motor |
| `npm run content:validate` | pasa cada caso de prueba del paquete de contenido por el motor y escribe el informe |
| `npm run hash-password` · `npm run audit` | hash argon2id de la contraseña de administrador · `npm audit --audit-level=high` |

## Inicio de sesión, tokens y producción

**Inicio de sesión de desarrollo.** Fuera de producción, sin `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH` ni `SESSION_SECRET`, el servidor usa la cuenta de desarrollo publicada `admin` / `centinela-dev` y lo advierte en su log. Para usar tu propia contraseña en local, ejecuta `npm run hash-password --silent`, escríbela dos veces y pega la línea que imprime en `.env`:

```bash
ADMIN_PASSWORD_HASH='$argon2id$v=19$m=65536,p=4,t=3$…'
```

Conserva las comillas simples: el hash contiene `$`, que la shell y Docker Compose expandirían. El comando nunca toma la contraseña de sus argumentos, exige al menos 12 caracteres y rechaza la contraseña de desarrollo.

**Auditoría de dependencias.** `npm run audit` falla ante avisos de severidad alta o crítica (`npm audit --audit-level=high`).

**Tokens de ingesta.** Los agentes de envío de logs y los scripts mandan líneas a `POST /api/ingest` con un token bearer: `INGEST_TOKEN` del entorno, o tokens creados en la página Seguridad del panel (se muestran una sola vez, se guardan como SHA-256, se pueden revocar y muestran su último uso). Las líneas pueden ir como texto plano o NDJSON, hasta 5 MB por solicitud; `npm run ingest` transmite archivos más grandes.

```bash
curl -X POST 'http://localhost:8080/api/ingest?source=linux_auth&host=bastion-01' \
  -H "Authorization: Bearer $INGEST_TOKEN" -H 'Content-Type: text/plain' \
  --data-binary @/var/log/auth.log
```

**Rechazos en producción.** Con `NODE_ENV=production` el servidor se niega a arrancar, nombrando la variable pero nunca su valor, si falta `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH` o `SESSION_SECRET`; si el hash no es argon2id, es más débil que el mínimo de OWASP (19 MiB, 2 iteraciones) o acepta la contraseña de desarrollo; si `SESSION_SECRET` o `INGEST_TOKEN` tiene menos de 32 caracteres o es un valor de desarrollo; o si `DATABASE_URL` usa la contraseña de la base de datos de desarrollo. `TRUST_PROXY=true` se rechaza en cualquier entorno. Todas las variables están documentadas en [`.env.example`](.env.example).

### Ejecutarlo en tu propio servidor

El archivo de Compose es para uso local: corre con secretos de desarrollo y publica cada puerto solo en 127.0.0.1. En un servidor:

1. Construye las dos imágenes (`docker build -f packages/server/Dockerfile .` y `docker build -f packages/web/Dockerfile .`) y ejecútalas junto a una base de datos PostgreSQL 16 propia. Aplica las migraciones con `node packages/server/dist/db/cli/migrate.js` en la imagen del servidor antes de arrancarlo (el archivo de Compose lo hace), y apunta el contenedor web al servidor con `API_UPSTREAM` (por defecto `http://server:3000`).
2. Define `NODE_ENV=production`, `DATABASE_URL`, `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH` (con `npm run hash-password`), y `SESSION_SECRET` e `INGEST_TOKEN` con `openssl rand -hex 32`. Guárdalos en tu gestor de secretos, no en el repositorio.
3. Pon un terminador TLS delante del contenedor web, sirve el panel y `/api` desde un mismo origen (el nginx incluido hace de proxy de `/api`) y envía HSTS desde el terminador. Sobre HTTPS, y siempre con `NODE_ENV=production`, las cookies de sesión y de CSRF son cookies `__Host-` con `Secure`.
4. Define `TRUST_PROXY` con el número de proxies delante de la API (`1` solo para el nginx incluido) o con sus direcciones o subredes, para que los límites de solicitudes, el bloqueo de inicio de sesión y el registro de auditoría vean la IP real del cliente. Sin esa variable todas las solicitudes parecen venir del proxy, y un solo bloqueo deja fuera a todo el mundo.
5. Si quieres vistas previas de enlaces, construye la imagen web con `--build-arg VITE_PUBLIC_URL=https://tu.host`.

La guía completa, incluidas las cookies que se usan sobre HTTP plano en localhost, está en [docs/SECURITY.md](docs/SECURITY.md) (en inglés).

## Pruebas

```bash
docker compose up -d --wait postgres
npm run lint && npm run typecheck && npm run db:migrate && npm test && npm run build
```

`npm test` ejecuta 1,342 pruebas en 96 archivos de los cuatro paquetes; cada prueba de base de datos crea un esquema desechable. Cubren cada tipo de mensaje de los parsers, cada modificador y construcción de la gramática, las ventanas de correlación en sus límites, cada endpoint de la API con su validación y paginación, la autenticación (bloqueo, CSRF, los dos modos de cookies, un `401` en cada ruta protegida), los 19 escenarios de punta a punta, las muestras de regresión de SigmaHQ, los casos del paquete de contenido y el panel (paridad de claves de i18n, cadenas hostiles mostradas como texto, navegación con teclado, contraste, la Content Security Policy). La CI ejecuta la misma secuencia en el runner de dos CPU de GitHub ([`ci.yml`](.github/workflows/ci.yml)).

## Hoja de ruta y limitaciones conocidas

Limitaciones conocidas, tomadas de los registros de decisiones de cada sesión:

- **Sigma:** no se admiten `expand` ni modificadores desconocidos, las condiciones de agregación, `near` ni las condiciones `lt`/`lte`/`eq` en correlaciones ([DETECTION.md](docs/DETECTION.md#not-supported)).
- **La ingesta NDJSON** convierte un objeto con una clave `message` en ese mensaje, así que se rechazan los eventos de Sysmon de un agente que la agrega (Winlogbeat lo hace); envíalos como texto plano, un objeto JSON por línea ([S5-09](docs/decisions/S5.md)).
- **La ingesta de la demostración está limitada por la base de datos:** unos 6,000 eventos/s a través de PostgreSQL frente a 85,255 eventos/s del motor solo ([DETECTION.md](docs/DETECTION.md#benchmark)).
- **El historial de cargas** de la página Ingesta se guarda en cada navegador, en el almacenamiento local ([S3](docs/decisions/S3.md)).
- **Los contadores del Resumen** se detienen en "200+" alertas nuevas; un conteo exacto requiere cambiar la API ([S7b-15](docs/decisions/S7b.md)).
- **El ancho del eje de los gráficos** se estima a partir de la longitud de la etiqueta, no se mide ([S7b-15](docs/decisions/S7b.md)).
- **Los usuarios de Windows** aparecen sin su dominio en la tabla de alertas; la página de la alerta muestra `DOMINIO\nombre` ([S7b-15](docs/decisions/S7b.md)).
- **Firefox** no se revisó; Chromium y WebKit sí ([S7b-18](docs/decisions/S7b.md)).
- Una sola cuenta de administrador sin segundo factor, y el estado de detección en un solo proceso ([modelo de amenazas](docs/THREAT_MODEL.md#residual-risks)).

Próximos pasos: cuentas y roles por analista, condiciones de rango en correlaciones, Sysmon por NDJSON tal como lo envía Winlogbeat, y más tipos de eventos de Windows.

## Guía del repositorio

| Ruta | Contenido |
| --- | --- |
| `packages/shared` | esquemas zod y tipos de eventos, alertas, reglas y la API HTTP; utilidades de ATT&CK |
| `packages/server` | API Express, parsers, pipeline de ingesta, motor de detección, migraciones |
| `packages/web` | panel en React (español e inglés) |
| `packages/loggen` | generador de datos de demostración con semilla y verdad de referencia |
| `rules/` | reglas de SigmaHQ incluidas (`sigma/`) y reglas de Centinela (`centinela/`, `correlation/`) |
| `content/` | guías de respuesta bilingües y casos de prueba por regla ([content/README.md](content/README.md)) |
| `data/mitre-attack/` | datos de referencia compactos de MITRE ATT&CK |
| `docs/` | [arquitectura](docs/ARCHITECTURE.md), [detección](docs/DETECTION.md), [modelo de amenazas](docs/THREAT_MODEL.md), [guía de seguridad](docs/SECURITY.md), [plan de construcción](docs/PLAN.md), [decisiones](docs/DECISIONS.md) (en inglés) |
| `tools/content-pack/` | la herramienta en Python que generó el paquete de contenido |

## Créditos

- **SigmaHQ.** Las reglas de [`rules/sigma/`](rules/sigma) vienen de [SigmaHQ](https://github.com/SigmaHQ/sigma) (commit `05d1031f`) bajo la [Detection Rule License 1.1](rules/sigma/LICENSE.Detection.Rules.md). Cada alerta, página de regla y guía de respuesta muestra el autor de la regla, un enlace a ella y la licencia. Diez reglas incluidas no tienen guía: detectan técnicas ofensivas, sus eventos de prueba habrían tenido que contener líneas de comando de ataque, y el filtro de seguridad del modelo detuvo los dos intentos. Están listadas en [content/README.md](content/README.md#rules-without-content):

  <details><summary>Las diez reglas sin guía de respuesta</summary>

  - HackTool - DInjector PowerShell Cradle Execution
  - HKTL - SharpSuccessor Privilege Escalation Tool Execution
  - Suspicious Encoded And Obfuscated Reflection Assembly Load Function Call
  - Assembly Loading Via CL_LoadAssembly.ps1
  - Potential Powershell ReverseShell Connection
  - Potential Privilege Escalation via Service Permissions Weakness
  - Suspicious NTLM Authentication on the Printer Spooler Service
  - Registry Modification of MS-settings Protocol Handler
  - UAC Bypass Using Disk Cleanup
  - UAC Bypass Using Event Viewer RecentViews

  </details>

- **MITRE ATT&CK®.** Tácticas y técnicas de [mitre/cti](https://github.com/mitre/cti) (matriz Enterprise modificada el 2026-07-31). © The MITRE Corporation. Esta obra se reproduce y distribuye con el permiso de The MITRE Corporation.
- **Tipografías.** [Atkinson Hyperlegible Next y Atkinson Hyperlegible Mono](packages/web/src/assets/fonts) del Braille Institute, bajo la SIL Open Font License 1.1, alojadas en el propio servidor.
- **Guías de respuesta.** Todas las guías de [`content/`](content) las escribió Claude, de Anthropic, a través de la API Message Batches con [`tools/content-pack`](tools/content-pack), y llevan la etiqueta "Generada con IA — revísala antes de usarla" en el panel y `"review": "unreviewed"` en su archivo hasta que una persona las revise.

## Licencia

Código: [MIT](LICENSE). Reglas de Sigma incluidas: [DRL 1.1](rules/sigma/LICENSE.Detection.Rules.md).
