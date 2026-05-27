# GuideMe — Product Specification

## Visión del Producto

GuideMe es una plataforma SaaS multi-tenant, optimizada para móviles, que centraliza la venta de servicios turísticos, el control de inventario en tiempo real, el cálculo de comisiones y la validación de accesos mediante códigos QR. Está diseñada para que empresas turísticas (organizaciones) puedan operar con agilidad en campo, garantizando control financiero y una experiencia digital moderna para el turista.

**Problema que resuelve:** Los equipos de ventas turísticas operan con hojas de cálculo, WhatsApp informal y efectivo sin trazabilidad. GuideMe reemplaza ese caos con una herramienta móvil-first que evita sobreventas, controla comisiones y entrega comprobantes digitales automáticamente.

---

## Principios de Diseño

- **Mobile-first:** Toda la interfaz de agentes se diseña para teléfono en campo, sin depender de un escritorio.
- **Offline-capable en validación QR:** El escáner funciona sin internet. Los tickets consumidos se sincronizan con el servidor al recuperar conexión.
- **Cero contraseñas para agentes y clientes:** Acceso por magic link a email o WhatsApp. Solo el admin usa contraseña.
- **Inventario en tiempo real:** Ningún agente puede vender más cupos de los disponibles en un horario dado.
- **Multitenancy:** Cada organización opera de forma completamente aislada (datos, catálogo, personal).

---

## Roles del Sistema

| Rol | Descripción | Autenticación |
|---|---|---|
| `admin` | Control total de la organización: catálogo, personal, reportes, finanzas | Email + contraseña |
| `agent` | Vende servicios, gestiona su caja diaria, escanea QR de acceso | Magic link por email o WhatsApp |
| `client` | Recibe boletos digitales y códigos QR vía WhatsApp. No interactúa con la app directamente en esta fase | Magic link por WhatsApp (futuro) |

---

## User Stories

### Administrador

#### Autenticación y Cuenta

- **US-A01** — Como admin, quiero registrarme con mi nombre, email, contraseña y nombre de empresa para crear mi organización en GuideMe.
- **US-A02** — Como admin, quiero verificar mi email haciendo clic en un magic link para activar mi cuenta.
- **US-A03** — Como admin, quiero iniciar sesión con email y contraseña para acceder a mi panel de control.
- **US-A04** — Como admin, quiero recuperar mi contraseña por email en caso de olvidarla.

#### Gestión de Personal

- **US-A05** — Como admin, quiero invitar a un agente de ventas por email o WhatsApp para que se una a mi organización.
- **US-A06** — Como admin, quiero ver la lista de agentes activos de mi organización con su porcentaje de comisión asignado.
- **US-A07** — Como admin, quiero editar el perfil y el porcentaje de comisión base de un agente.
- **US-A08** — Como admin, quiero desactivar (dar de baja) a un agente para que pierda acceso a la plataforma sin eliminar su historial.

#### Catálogo de Servicios

- **US-A09** — Como admin, quiero crear un servicio turístico (ej. "Recorrido Cañón al Amanecer") con nombre, descripción, precio base, precio mínimo de venta y capacidad máxima por horario.
- **US-A10** — Como admin, quiero definir horarios recurrentes o fechas específicas para cada servicio, con su cupo independiente por slot.
- **US-A11** — Como admin, quiero agregar "extras" opcionales a un servicio (ej. "Foto profesional", "Seguro de viaje") con su precio individual.
- **US-A12** — Como admin, quiero definir un bonus de comisión adicional por servicio específico, que se suma al % base del agente.
- **US-A13** — Como admin, quiero editar o desactivar un servicio del catálogo sin afectar los folios ya vendidos.

#### Dashboard y Monitoreo

- **US-A14** — Como admin, quiero ver un tablero visual de ocupación que muestre el estado (disponible / próximo a saturarse / lleno) de todos los horarios activos del día.
- **US-A15** — Como admin, quiero ver en tiempo real cuántos lugares quedan disponibles por servicio y horario.
- **US-A16** — Como admin, quiero ver un resumen de ventas del día: total recaudado, número de folios, ventas por agente.

#### Reportes Financieros y Comisiones

- **US-A17** — Como admin, quiero generar un reporte de comisiones por agente en un período de fechas, mostrando ventas totales, comisión base, bonus por servicio y comisión total a pagar.
- **US-A18** — Como admin, quiero ver un comparativo de desempeño entre agentes (folios vendidos, monto total) en un período dado.
- **US-A19** — Como admin, quiero revisar y validar los cortes de caja diarios entregados por los agentes.
- **US-A20** — Como admin, quiero exportar reportes de ventas y comisiones (CSV o PDF) para su procesamiento externo.

#### Cancelaciones

- **US-A21** — Como admin, quiero cancelar un folio completo para liberar automáticamente los cupos de todos los servicios incluidos y dejar registro de la cancelación.

---

### Agente de Ventas

#### Autenticación

- **US-AG01** — Como agente, quiero aceptar mi invitación haciendo clic en el enlace recibido por email o WhatsApp para activar mi cuenta en GuideMe.
- **US-AG02** — Como agente, quiero solicitar un magic link a mi email o WhatsApp para iniciar sesión sin necesidad de recordar una contraseña.

#### Punto de Venta

- **US-AG03** — Como agente, quiero ver el catálogo de servicios disponibles con su disponibilidad en tiempo real (cupos restantes por horario) para elegir qué vender.
- **US-AG04** — Como agente, quiero seleccionar un servicio, elegir un horario disponible y agregar el número de personas para iniciar una venta.
- **US-AG05** — Como agente, quiero agregar extras opcionales al carrito de venta (ej. foto, seguro) para aumentar el ticket promedio.
- **US-AG06** — Como agente, quiero aplicar un descuento manual al precio de un servicio, con el límite bloqueado en el precio mínimo definido por el admin, para evitar vender por debajo del costo permitido.
- **US-AG07** — Como agente, quiero registrar una venta como "apartado" con un monto parcial recibido, para reservar el cupo y cobrar el resto después.
- **US-AG08** — Como agente, quiero confirmar la venta y generar un folio único que incluya todos los servicios del carrito.
- **US-AG09** — Como agente, quiero que el cliente reciba automáticamente por WhatsApp su comprobante de compra, itinerario y código QR al confirmar la venta.

#### Disponibilidad en Tiempo Real

- **US-AG10** — Como agente, quiero ver en la pantalla de venta una indicación clara de cuántos cupos quedan por servicio/horario para evitar vender servicios llenos.
- **US-AG11** — Como agente, quiero que el sistema me bloquee la confirmación de venta si el cupo ya no está disponible al momento de confirmar (protección contra race conditions).

#### Caja Diaria

- **US-AG12** — Como agente, quiero ver un resumen de mis ventas del día: folios generados, total en efectivo, total de apartados pendientes de cobro.
- **US-AG13** — Como agente, quiero registrar gastos operativos del día (ej. gasolina, insumos) con monto y descripción para que el balance neto de mi caja sea real.
- **US-AG14** — Como agente, quiero generar mi corte de caja diario con el desglose de ingresos, gastos y balance neto para entregarlo al admin.

#### Escáner de Acceso (QR)

- **US-AG15** — Como agente, quiero usar la cámara de mi teléfono para escanear el código QR de un cliente y validar su boleto al momento del acceso al servicio.
- **US-AG16** — Como agente, quiero que la validación del QR funcione sin internet, marcando el ticket como consumido en mi dispositivo y sincronizando cuando recupere conexión.
- **US-AG17** — Como agente, quiero ver una pantalla clara de resultado del escaneo: ✓ Válido (nombre del cliente, servicio, horario) o ✗ Inválido (razón: ya usado, expirado, falso).

---

### Cliente

> En esta fase el cliente no interactúa directamente con la app. Su experiencia es 100% por WhatsApp.

- **US-C01** — Como cliente, quiero recibir automáticamente por WhatsApp un comprobante de compra con el detalle de mi servicio, horario y monto pagado al momento de la venta.
- **US-C02** — Como cliente, quiero recibir un código QR único por cada servicio adquirido para presentarlo como boleto de acceso.
- **US-C03** — Como cliente, quiero recibir una notificación por WhatsApp si mi folio es cancelado para saber que mi reserva ya no está activa.

---

## Funcionalidades por Fase

### Fase 1 — MVP (Alcance Inicial)

| Módulo | Incluido |
|---|---|
| Auth (admin, agente, cliente) | ✅ |
| Gestión de personal (invitar, editar, desactivar agentes) | ✅ |
| Catálogo de servicios con extras y precio mínimo | ✅ |
| Horarios/slots con cupo por fecha y hora | ✅ |
| Punto de venta móvil con descuento controlado | ✅ |
| Apartados (pago parcial con reserva de cupo) | ✅ |
| Generación de folio con QR firmado (HMAC) | ✅ |
| Envío de comprobante y QR al cliente por WhatsApp | ✅ |
| Escáner QR offline-capable con sync posterior | ✅ |
| Caja diaria del agente con gastos operativos | ✅ |
| Dashboard visual de ocupación (admin) | ✅ |
| Comisiones: % base por agente + bonus por servicio | ✅ |
| Reporte de comisiones por período | ✅ |
| Cancelación total de folio | ✅ |
| Multitenancy (organizaciones aisladas) | ✅ |

### Fuera del MVP (Fase 2+)

| Funcionalidad | Razón de exclusión |
|---|---|
| Pagos con tarjeta integrados (Stripe, Conekta) | Complejidad de integración de pagos |
| Compra online self-service por el cliente | Requiere pasarela de pago y flujo de checkout |
| Cancelaciones parciales (por servicio dentro del folio) | Simplificar lógica de inventario en MVP |
| App nativa (iOS / Android) | PWA mobile-first es suficiente en Fase 1 |
| Registro silencioso de clientes por mensaje de WhatsApp | Requiere WhatsApp Business API bidireccional (webhook) |
| Exportación de reportes (PDF/CSV) | Fase 2 post-validación de reportes en pantalla |
| Múltiples métodos de pago (tarjeta, transferencia) | Solo efectivo en Fase 1 |

---

## Reglas de Negocio Clave

### Inventario

- Cada slot (servicio + fecha + hora) tiene un `cupo_maximo` definido por el admin.
- Al confirmar una venta (incluyendo apartados), el cupo se descuenta inmediatamente.
- Si al momento de confirmar el cupo llegó a 0 (race condition), la venta se rechaza con error claro.
- Al cancelar un folio, todo el cupo de los slots involucrados se libera.

### Precios y Descuentos

- Cada servicio tiene `precio_base` y `precio_minimo` (ambos definidos por el admin).
- El agente puede reducir el precio hasta `precio_minimo`, inclusive. Por debajo, el sistema bloquea la venta.
- Los extras tienen precio fijo; no se les aplica descuento.

### Comisiones

- Cada agente tiene un `comision_base` (%) asignado por el admin.
- Cada servicio puede tener un `bonus_comision` (%) adicional definido por el admin.
- Comisión total por línea de venta = `(precio_vendido × comision_base) + (precio_vendido × bonus_comision)`.
- Las comisiones se calculan sobre el precio final vendido (post-descuento), no sobre el precio base.
- Los apartados generan comisión solo sobre el monto efectivamente cobrado hasta el corte.

### Apartados (Pago Parcial)

- Un apartado reserva el cupo del slot igual que una venta completa.
- El agente registra el monto recibido (`monto_apartado`) y el saldo pendiente se calcula automáticamente.
- El folio queda en estado `apartado` hasta que se cobra el saldo restante y cambia a `pagado`.

### QR y Validación de Acceso

- El QR contiene un payload JSON firmado con HMAC-SHA256 usando un `QR_SECRET` por organización.
- El payload incluye: `folio_id`, `servicio_id`, `slot_id`, `cliente_identity`, `expires_at`.
- La validación offline verifica la firma localmente. Si la firma es inválida → ✗ Falso.
- Los tickets consumidos se almacenan en `localStorage` del dispositivo del agente escaneador.
- Al recuperar conexión, el dispositivo sincroniza los tickets consumidos con el servidor (`POST /api/tickets/sync`).
- El servidor es la fuente de verdad: si un ticket ya fue marcado como consumido en el servidor por otro dispositivo, prevalece ese estado.

### Multitenancy

- Todos los datos (servicios, agentes, folios, slots) pertenecen a una `organization_id`.
- Un agente solo puede ver y vender servicios de su propia organización.
- El admin solo gestiona su propia organización.

---

## Integraciones Externas

| Servicio | Propósito |
|---|---|
| **Agnostic Auth** (Cloudflare Worker) | Emisión de JWT y magic links |
| **Resend** | Emails transaccionales: verificación admin, invitación agente, reset de contraseña |
| **Meta WhatsApp Cloud API** | Magic links para agentes (teléfono), comprobantes + QR para clientes, invitaciones por WhatsApp |
| **Cloudflare D1** | Base de datos principal (SQLite) |
| **Cloudflare Workers** | Runtime del backend (Hono) |

---

## Glosario

| Término | Definición |
|---|---|
| **Folio** | Registro de una venta completa. Puede incluir uno o más servicios. Tiene un ID único y un QR por servicio. |
| **Slot** | Una instancia de un servicio en una fecha y hora específica, con cupo máximo propio. |
| **Extra** | Producto o servicio opcional que se suma a un folio (ej. foto, seguro). |
| **Apartado** | Folio con pago parcial que reserva el cupo pero queda pendiente de cobro completo. |
| **Corte de caja** | Resumen diario del agente: ventas, gastos operativos y balance neto. |
| **Precio mínimo** | Piso de precio por servicio definido por el admin. El agente no puede vender por debajo. |
| **Bonus de comisión** | Porcentaje adicional de comisión definido por el admin para un servicio específico. |
