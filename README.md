# Borradores de WhatsApp para temas de trabajo

Se conecta a tu WhatsApp personal, detecta qué mensajes son de **trabajo** y te
prepara un **borrador de respuesta**. Los temas personales y de ocio se ignoran
por completo.

**Nunca envía nada por su cuenta.** Cada borrador espera a que tú lo revises,
lo edites si quieres y pulses Enviar desde un panel web que puedes abrir en el
móvil.

```
Mensaje entrante ─▶ ¿reglas fijas? ─▶ ¿trabajo o personal? (IA) ─▶ borrador ─▶ TÚ decides ─▶ enviar
                       │                        │
                       └── ignorado             └── personal / dudoso → no se hace nada
```

## Antes de empezar: qué asumes

WhatsApp no ofrece una API oficial para cuentas personales. Esto usa
[Baileys](https://github.com/WhiskeySockets/Baileys), una librería no oficial que
se vincula como si fuera WhatsApp Web. Funciona bien, pero **existe un riesgo real
de que WhatsApp bloquee tu número** si detecta comportamiento automatizado.

Lo que hace este proyecto para minimizar ese riesgo:

- Nunca responde solo: todo mensaje sale porque tú has pulsado un botón.
- No manda mensajes masivos ni a desconocidos, solo respuestas en chats existentes.
- Simula el "escribiendo…" con una pausa proporcional a la longitud del texto.
- No se marca como "en línea" solo por estar abierto, ni marca mensajes como leídos.

Aun así, el riesgo no es cero. Úsalo con tu criterio.

## Instalación

Necesitas Node.js 20 o superior.

```bash
npm install
cp .env.example .env
```

Edita `.env` y rellena como mínimo:

- `ANTHROPIC_API_KEY` — tu clave de https://console.anthropic.com/
- `PANEL_TOKEN` — una contraseña larga para entrar al panel. Genera una con:
  ```bash
  node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
  ```
- `PAIRING_PHONE` — tu número con prefijo, sin `+` ni espacios (ej. `34600111222`).
  Con esto la vinculación es por código de 8 letras, mucho más cómoda desde el
  móvil. Si lo dejas vacío, se usa el QR de siempre.

Arranca:

```bash
npm start
```

## Vincular WhatsApp

**Con código (recomendado):** en la terminal aparecerá un código tipo `ABCD-EFGH`.
En el teléfono: WhatsApp › Ajustes › Dispositivos vinculados › Vincular con número
de teléfono › escribe el código. El código también sale en el panel web.

**Con QR:** deja `PAIRING_PHONE` vacío; el QR se dibuja en la terminal y también
aparece en el panel (útil si abres el panel en el ordenador).

## Abrir el panel desde el móvil

Al arrancar, la terminal imprime algo así:

```
Panel escuchando en http://localhost:3000
Desde el móvil (misma WiFi): http://192.168.1.42:3000
```

Abre esa segunda dirección en el navegador del móvil, mientras el ordenador y el
teléfono estén en la misma red WiFi. Te pedirá el `PANEL_TOKEN` una sola vez.

Añádelo a la pantalla de inicio ("Añadir a inicio" en Safari o Chrome) y se
comporta prácticamente como una app.

> El panel escucha en toda la red local. El token es lo único que impide que otro
> dispositivo de tu WiFi envíe mensajes en tu nombre: usa uno largo. No lo
> expongas a Internet sin poner HTTPS y un proxy delante.

## Cómo decide qué es trabajo

En dos pasos, y el primero manda:

1. **Reglas fijas** (pestaña Ajustes del panel, o `config/rules.json`):
   - `workContacts` / `workGroups`: siempre trabajo, sin preguntar a la IA.
   - `ignoreContacts` / `ignoreGroups`: nunca se hace nada con ellos.
   - `groupsDefault`: qué pasa con los grupos no listados. Por defecto `ignore`,
     porque los grupos generan mucho ruido.
   - También puedes marcar un chat como trabajo/personal desde la lista de chats
     recientes del panel.
2. **IA** para lo que quede sin decidir. Claude lee los últimos mensajes y
   responde `work`, `personal` o `unclear`.

Solo se genera borrador si el resultado es `work`, con confianza ≥ 0.6, **y** el
último mensaje pide realmente una respuesta. En cualquier otro caso no pasa nada.
Un compañero de trabajo hablándote de la cena del viernes es `personal`.

Cuéntale a qué te dedicas en el campo "A qué te dedicas" de Ajustes: es lo que
más mejora la clasificación.

## Cómo se comporta

- **Ráfagas de mensajes:** espera `DEBOUNCE_SECONDS` (15 por defecto) tras el
  último mensaje antes de analizar, así cinco mensajes seguidos generan un
  borrador, no cinco.
- **Un borrador por chat:** si llegan mensajes nuevos, se actualiza el borrador
  pendiente en vez de acumular.
- **Si contestas tú a mano:** el borrador pendiente de ese chat se descarta solo.
- **Datos que no tiene:** la IA no inventa precios ni fechas. Deja huecos como
  `[precio]` o `[fecha]` para que los rellenes antes de enviar.
- **Regenerar:** puedes pedir otra versión, opcionalmente con una instrucción
  ("más corto", "dile que no puedo hasta el jueves").

## Ficheros y datos

Todo se queda en tu máquina:

| Ruta                  | Qué es                                                     |
| --------------------- | ---------------------------------------------------------- |
| `auth/`               | Credenciales de la sesión de WhatsApp. **No las compartas.** |
| `data/whatsapp.db`    | SQLite con mensajes recientes, borradores y decisiones.     |
| `config/rules.json`   | Tus reglas de clasificación.                                |
| `.env`                | Claves y configuración.                                     |

Los cuatro están en `.gitignore`. El contenido de los mensajes que se clasifican
sí se envía a la API de Anthropic; los personales solo llegan hasta el
clasificador, y los ignorados por reglas no salen de tu máquina.

Para desvincular y empezar de cero:

```bash
npm run logout
```

(Revoca también la sesión desde WhatsApp › Dispositivos vinculados si quieres.)

## Coste

Por defecto usa `claude-opus-5` para clasificar y para redactar. El clasificador
se ejecuta con cada conversación entrante, así que es la parte que más se llama.
Si quieres abaratarlo, en `.env`:

```
CLASSIFIER_MODEL=claude-haiku-4-5
```

El redactor solo entra en juego con mensajes ya marcados como trabajo, así que
ahí compensa dejar el modelo bueno.

## Estructura del código

```
src/
  index.js       arranque: conecta WhatsApp + levanta el panel
  whatsapp.js    conexión Baileys, extracción de mensajes, envío
  pipeline.js    debounce, orquestación: clasificar → redactar → guardar
  classifier.js  reglas fijas + clasificación con Claude
  drafter.js     redacción del borrador
  db.js          esquema y consultas SQLite
  server.js      API HTTP del panel
  config.js      .env y config/rules.json
public/          panel web (HTML/CSS/JS sin dependencias)
```

## Problemas frecuentes

**"Sesión cerrada desde el teléfono"** — cerraste la sesión en Dispositivos
vinculados. Ejecuta `npm run logout` y vuelve a vincular.

**El panel no abre desde el móvil** — comprueba que `HOST=0.0.0.0` en `.env`, que
ambos están en la misma WiFi y que el firewall del ordenador deja pasar el puerto
3000.

**No aparece ningún borrador** — mira la pestaña Historial: ahí se ve qué decidió
el clasificador en cada chat y por qué. Lo más habitual es que sea un grupo y
`groupsDefault` esté en `ignore`.

**Se genera borrador para cosas personales** — añade el contacto a
`ignoreContacts`, o marca el chat como Personal en Ajustes, y afina el campo "A
qué te dedicas".
