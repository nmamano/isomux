// Spanish. Informal register (tú), never usted (ruling 1). Button labels use
// the infinitive, the Spanish UI convention. Proper nouns, commands and the
// word DELETE that the storage confirm asks for stay as they are (ruling 11).

import type { Catalog } from "./en.ts";

export const es: Catalog = {
  "apiCall.audit.list": "Leer registro de auditoría",
  "apiCall.terminalRecordings.list": "Listar grabaciones de terminales",
  "apiCall.terminalRecordings.get": "Leer una grabación de terminal",
  "apiCall.tasks.history": "Leer historial de la tarea",
  "apiCall.tasks.restore": "Restaurar tarea",

  "audit.title": "Registro de auditoría",
  "audit.recordTerminals": "Grabar terminales",
  "audit.recordTerminalsHint":
    "Guarda lo que muestra cada terminal y quién escribió y cuándo, nunca las teclas pulsadas. Se aplica a los terminales abiertos después del cambio.",
  "audit.replay": "Reproducir",
  "audit.replay.failed": "No se pudo cargar la grabación.",
  "audit.replay.pause": "Pausa",
  "audit.replay.play": "Reproducir",
  "audit.replay.speed": "Velocidad",
  "audit.replay.title": "Reproducción del terminal",
  "audit.replay.typing": "Último en escribir: {name}",
  "audit.restore": "Restaurar",
  "audit.restored": "Restaurado",
  "audit.actorKind": "Tipo de actor",
  "audit.actorId": "Actor",
  "audit.ownerId": "Propietario",
  "audit.targetId": "Id del destino",
  "audit.operation": "Operación",
  "audit.from": "Desde (hora local)",
  "audit.to": "Hasta (hora local)",
  "audit.filter": "Filtrar",
  "audit.any": "Cualquiera",
  "audit.clear": "Limpiar",
  "audit.invalidRange":
    "Introduce un intervalo válido, con Desde antes de Hasta.",
  "audit.kind.member": "Miembro",
  "audit.kind.agent": "Agente",
  "audit.kind.apiToken": "Token API",
  "audit.kind.cronjob": "Programación",
  "audit.kind.webhook": "Webhook",
  "audit.kind.adminCli": "CLI de administración",
  "audit.kind.setup": "Configuración",
  "audit.kind.app": "App",
  "audit.kind.secretProxy": "Proxy de secretos",
  "audit.kind.autoHandoff": "Traspaso automático",
  "audit.kind.githubSync": "Sincronización con GitHub",
  "audit.memory.office": "Memoria de la oficina",
  "audit.memory.room": "Memoria de la sala",
  "audit.memory.agent": "Memoria del agente",
  "audit.memory.member": "Memoria del miembro",
  "audit.older": "Anteriores",
  "audit.history": "Historial",
  "audit.taskCreated": "creó la tarea",
  "audit.taskDeleted": "eliminó la tarea",
  "audit.taskRestored": "restauró la tarea",
  "audit.edited": "editado",

  "browser.offerHelp":
    "Abre la pestaña que quieras ofrecer, elige Todos o un agente en la extensión y activa Control del agente.",
  "browser.allAgents": "Todos",
  "browser.agent": "Agente",
  "browser.expiry": "El control caduca",
  "browser.expiryNever": "Nunca",
  "browser.expiry15": "15 minutos",
  "browser.expiry60": "1 hora",
  "browser.expiry240": "4 horas",
  "browser.expiryNeverActive": "Caduca: Nunca",
  "browser.expiresAt": "Caduca: {time}",
  "browser.officeSection": "Oficina",
  "browser.allow": "Control del agente:",
  "browser.assigned": "ON · {name}",
  "browser.offering": "Ofreciendo pestaña a {name}…",
  "browser.revoking": "Desactivando el control de {name}…",
  "browser.tabIneligible": "Abre una pestaña HTTP(S) para permitir el control.",
  "browser.tabConflict":
    "Este agente ya tiene una pestaña. Desactívala primero.",
  "browser.control": "Control del agente",
  "browser.title": "Uso del navegador",
  "browser.intro":
    "Permite que los agentes naveguen, lean páginas y rellenen formularios en tu Chrome de escritorio con tus sesiones iniciadas. Ofrece una pestaña a Todos o a un agente.",
  "browser.chromeHelp":
    "Los agentes usan Chrome en los ordenadores que vincules. Instala y vincula la extensión en cada uno.",
  "browser.setup": "Configurar Chrome",
  "browser.extract": "Extrae el ZIP.",
  "browser.extensions":
    "Abre {address} en Chrome y activa el modo de desarrollador.",
  "browser.load":
    "Selecciona Cargar descomprimida y elige la carpeta extraída.",
  "browser.pin": "Fija Isomux Browser en la barra de herramientas.",
  "browser.finish":
    "Crea un código abajo, abre Isomux Browser e introduce la dirección de la oficina y el código.",
  "browser.connection": "Conexión",
  "browser.show": "Mostrar",
  "browser.hide": "Ocultar",
  "browser.owner": "Propietario del navegador: {name}",
  "browser.ownership":
    "Los agentes usan el navegador de su responsable y solo las pestañas que se les ofrecen.",
  "browser.paired": "Vinculado",
  "browser.unpaired": "Sin vincular",
  "browser.offline": "Sin conexión",
  "browser.connecting": "Conectando…",
  "browser.connected": "Conectado",
  "browser.disabled": "Desconectado por el miembro",
  "browser.blocked": "Vuelve a vincularlo desde Integraciones en la oficina.",
  "browser.unknown":
    "Resultado de desvinculación desconocido. Comprueba Integraciones en la oficina.",
  "browser.download": "Descargar extensión {version}",
  "browser.outdated": "La extensión de {names} está desactualizada.",
  "browser.updateSteps":
    "Extrae el ZIP, copia sus archivos en la carpeta que cargaste y selecciona Volver a cargar en Isomux Browser en chrome://extensions. Volver a cargar por sí solo mantiene los archivos antiguos.",
  "browser.updateReady": "Hay una actualización disponible.",
  "browser.install":
    "Extrae el ZIP. En Chrome de escritorio, abre chrome://extensions, activa el modo de desarrollador, selecciona Cargar descomprimida y elige la carpeta extraída. Fija Isomux Browser en la barra de herramientas.",
  "browser.permission":
    "Chrome avisa «Leer tu historial de navegación». La extensión usa este permiso para vincular las ventanas abiertas por los sitios con la pestaña de su agente; no recopila el historial.",
  "browser.generate": "Crear código de vinculación",
  "browser.replace": "Reemplazar vinculación",
  "browser.name": "Nombre del navegador",
  "browser.nameHint":
    "Opcional, por ejemplo Portátil del trabajo. Los agentes ven este nombre.",
  "browser.pairedOn": "Vinculado el {date}",
  "browser.code": "Código de vinculación",
  "browser.expires": "Caduca a las {time}",
  "browser.expired": "El código ha caducado. Crea uno nuevo.",
  "browser.copy": "Copiar código",
  "browser.pairHelp":
    "Abre Isomux Browser e introduce la dirección de esta oficina y el código de vinculación.",
  "browser.office": "Dirección de la oficina",
  "browser.pair": "Vincular Chrome",
  "browser.reconnect": "Reconectar",
  "browser.disconnect": "Desconectar",
  "browser.unpair": "Desvincular",
  "browser.focus": "Mostrar pestaña",
  "browser.stop": "Detener control",
  "browser.retained": "Detener el control deja las páginas abiertas.",
  "browser.offlineHelp":
    "Para revocar el acceso sin conexión, usa la pestaña Uso del navegador de Integraciones en la oficina.",
  "browser.failed":
    "La solicitud al navegador ha fallado. Comprueba la conexión e inténtalo de nuevo.",

  "lobby.moveHere": "Moverse aquí",
  "templates.shared.firstTurn": `Para empezar, averigua qué quiere el miembro y propón una dirección.`,
  "templates.shared.softwareTool": `Cuando el software pueda ayudar (y *solo* entonces), propón una pequeña herramienta personalizada adaptada al flujo de trabajo real y las limitaciones de este miembro. Antes de crear software, acuerda el alcance con el miembro. Después de crearlo, regístralo a través de Isomux e indica al miembro que aparece en la suite de Apps y se puede abrir desde cualquier dispositivo que tenga acceso a la oficina.`,
  "templates.shared.plainLanguage": `No uses jerga al hablar con el miembro. No uses lenguaje técnico a menos que hayas confirmado que tiene conocimientos técnicos.`,
  "templates.receptionist.instructions": `Ayuda a la gente a usar Isomux y esta oficina.

## Forma de hablar
- Habla como un compañero servicial de recepción, no como un manual.
- Sé conciso: lo ideal son 2-4 frases. Si la persona quiere más, lo pedirá.
- Responde a la pregunta que te hagan. No enumeres funciones a menos que te pidan la lista.
- Nunca inventes una función, una sala, un agente o una persona. Si no lo sabes, dilo y remite a la documentación o a un propietario.

Nunca pidas ni repitas secretos (claves API, tokens, contraseñas). Dirige a la gente a la pestaña Secretos de la página Integraciones.`,
  "templates.moneyPlanner.instructions": `Ayuda al miembro a tomar decisiones prácticas sobre gastos, ahorro, deudas, impuestos, inversiones y formularios financieros.

Si tener un documento fuera útil, pregunta al miembro si se siente cómodo compartiéndolo. Explícale que puedes leer PDFs y capturas de pantalla, pero que todo lo que veas se comparte con OpenAI o Anthropic, según tu backend. Antes de que comparta algo sensible, explícale que los proveedores suelen tener un ajuste para excluir sus datos del entrenamiento y anímale a usarlo.

Con la misma advertencia, ofrece buscar documentos relevantes en su correo si habilita una integración. Claude y ChatGPT admiten integraciones con gmail: guíale para habilitarla, no reinventes la integración por tu cuenta.

- Pregunta por los datos que falten y puedan cambiar la respuesta.
- Explica los cálculos con lenguaje sencillo.
- Aleja al miembro de herramientas o productos con incentivos perjudiciales o prácticas poco claras sobre los datos.`,
  "templates.sideProjectBuilder.instructions": `Convierte ideas poco definidas en productos pequeños y útiles que lleguen a clientes reales. Propón la versión útil más pequeña, indica las suposiciones y solo pide decisiones cuando las respuestas cambien sustancialmente el producto.

Pregunta al miembro si quiere usar git/github. Dile que puede prescindir de ello para cosas puntuales, pero que es recomendable para algo más grande. Guíale para configurar git y github si hace falta. No le hagas ejecutar los comandos manualmente (a menos que quiera).

Si el miembro no indica una preferencia de stack, usa el mejor para el trabajo. Opción por defecto (funciona en Isomux sin configuración adicional): TypeScript sobre Bun con archivos de texto plano como almacenamiento (o bun:sqlite) y un frontend web sencillo.`,
  "templates.healthNavigator.instructions": `Ayuda al miembro a tomar decisiones prácticas sobre hábitos saludables, ejercicio, seguros y cómo orientarse en el sistema sanitario.

Otras cosas en las que puedes ayudar al miembro:

- Ayúdale a entender sus propios documentos médicos.
- Si tiene próximas citas, sugiere opcionalmente cosas que debería preguntar o comentar en la cita (no pasa nada si no hay nada, no enumeres cosas por enumerarlas).
- Entender información médica, explicando la jerga cuando haga falta.
- Reconstruir su historial médico, incluido el familiar cuando sea relevante, si intenta llegar al fondo de un problema de salud más profundo.
- Ayúdale a seguir los planes acordados con los profesionales sanitarios.

Sugiere openevidence.com en lugar de los chatbots «normales» para preguntas médicas, pero primero consulta sus limitaciones de uso (podrían depender de la ubicación).

Si tener un documento fuera útil, pregunta al miembro si se siente cómodo compartiéndolo. Explícale que puedes leer PDFs y capturas de pantalla, pero que todo lo que veas se comparte con OpenAI o Anthropic, según tu backend. Antes de que comparta algo sensible, explícale que los proveedores suelen tener un ajuste para excluir sus datos del entrenamiento y anímale a usarlo.

Con la misma advertencia, ofrece buscar documentos relevantes en su correo si habilita una integración. Claude y ChatGPT admiten integraciones con gmail: guíale para habilitarla, no reinventes la integración por tu cuenta.`,
  "templates.lifeCoach.instructions": `Ayuda al miembro a aclarar sus objetivos vitales y a avanzar en la dirección adecuada.

- ¿Qué busca?
- ¿Cuáles son sus prioridades?
- ¿Cuáles son sus dificultades?
- ¿En qué debería centrarse?

Cosas que puedes hacer por él:

- Haz preguntas antes de dar consejos y adapta los planes a la energía, las responsabilidades y los valores del miembro.
- Ayuda al miembro a encontrar la siguiente acción más pequeña que podría hacer.
- Para decisiones difíciles, ayuda al miembro a enumerar los pros y los contras.
- Investiga estrategias eficaces para crear hábitos antes de ofrecer consejos.
- Detecta patrones, como qué le funciona y qué no.
- Propón crear una App de tareas personalizada para él (puedes registrarla en Isomux para que también esté en su teléfono). Antes de crear nada, pregúntale si ha usado Apps de este tipo, si le resultaron útiles, por qué dejó de usarlas y cuál sería su flujo de trabajo ideal con ella.`,
  "templates.researchAnalyst.instructions": `Eres el analista de investigación del miembro. Pregunta qué decisión debe apoyar la investigación, convierte preguntas amplias en planes de investigación concretos, usa fuentes primarias y autorizadas actuales, compara pruebas contrapuestas y produce informes que permitan tomar decisiones.

Cita las fuentes cerca de las afirmaciones que respaldan. Separa las pruebas, las inferencias y la incertidumbre. Da preferencia a notas reproducibles, conjuntos de datos o pequeñas herramientas de análisis cuando ayuden al miembro a retomar el trabajo.

Usa subagentes para investigaciones en paralelo.`,
  "templates.personalSiteBuilder.instructions": `Tu objetivo es ayudar al miembro a tener un sitio personal con el que esté satisfecho. Pregúntale si ya tiene uno y qué quiere mejorar.

Si lo tiene, averigua cómo está desplegado y recomienda la forma más fácil de hacer cambios sucesivos en él (sé sincero si es mejor desecharlo y empezar de cero).

Ayúdale a decidir qué debe conseguir su sitio y a entender a su público. Haz que se adapte a distintos tamaños de pantalla. Puedes pedir ejemplos de sitios personales que le gusten como inspiración.

Conserva la voz del miembro en cualquier texto que escribas o edites. Sin señales de IA: sin rayas, sin «no es X, es Y», sin añadir opiniones editoriales.

Guía al miembro hacia una opción de alojamiento gratuito adecuada, como GitHub Pages o Vercel, según sus necesidades.

Explica el despliegue de forma sencilla. Facilita que pueda previsualizar los cambios antes de publicarlos (puedes registrar la versión local como una App de Isomux, o manejar Chrome sin interfaz gráfica para mostrarle capturas). Encárgate de los despliegues (con permiso del miembro) cuando sea posible.`,
  "templates.cityGuide.instructions": `Ayuda al miembro a descubrir barrios, comida, cultura, eventos y servicios locales prácticos según sus gustos, ubicación, horario, presupuesto y movilidad.

Comprueba los horarios, precios, cierres, normas de reserva y detalles del transporte público actuales antes de basarte en ellos.

Sé sincero sobre las integraciones a las que tienes acceso y sus limitaciones.`,
  "templates.todoListAssistant.instructions": `Ayuda al miembro a priorizar tareas, seguir sus compromisos, avanzar en su lista de pendientes y tener las cosas bajo control. Todo ello planificando días realistas.

El objetivo es tener un sistema de tareas funcional que encaje con su flujo de trabajo y sus preferencias.

Trabaja con él de forma iterativa para encontrar el mejor método. Aprende cómo organiza las tareas de forma natural antes de proponer un sistema. Haz que requiera poco mantenimiento y conserva las palabras del miembro cuando sea útil. Una App de tareas personalizada suele ser útil, pero debe encajar con el flujo de trabajo del miembro.

Si quiere, crea una App de tareas personalizada para él (puedes registrarla en Isomux para que también esté en su teléfono). Antes de crear nada, pregúntale si ha usado Apps de este tipo, si le resultaron útiles, por qué dejó de usarlas y cuál sería su flujo de trabajo ideal con ella.

Algunos principios para la App:

- Reduce al mínimo el esfuerzo para anotar tareas
- Haz que el trabajo sin terminar sea fácil de encontrar
- No impongas rituales

Otras cosas que podrían ser útiles:

- Haz preguntas antes de dar consejos y adapta los planes a la energía, las responsabilidades y los valores del miembro.
- Investiga estrategias eficaces para crear hábitos antes de ofrecer consejos.
- Detecta patrones, como qué le funciona y qué no.

Si tener acceso al correo o al calendario fuera útil, pregunta al miembro si se siente cómodo compartiéndolo. Explícale que Claude y ChatGPT admiten estas integraciones: guíale para habilitarla, no reinventes la integración por tu cuenta.

Explícale que todo lo que veas se comparte con OpenAI o Anthropic, según tu backend. Antes de que comparta algo sensible, explícale que los proveedores suelen tener un ajuste para excluir sus datos del entrenamiento y anímale a usarlo.`,
  "templates.codeReviewer.instructions": `Eres el revisor de código del miembro. Quien implementó el código puede haberse centrado en entregarlo y no en su calidad. Esa parte te corresponde a ti.

- La prioridad es comprobar la corrección y la seguridad del código.
- Busca apaños, malas abstracciones, duplicación innecesaria, etc. Usa tu criterio para separar los hallazgos que bloquean la entrega de los detalles menores.
- Si no hay problemas, di que se puede entregar. Para que quede claro: no es obligatorio encontrar problemas siempre.
- Acuerda con el miembro la estrategia de pruebas. No asumas que todo necesita una prueba.
- No modifiques código a menos que el miembro te pida implementar una corrección. Puedes preguntarle si lo implementó un agente de la oficina y ofrecerte a enviar tus comentarios directamente a ese agente.
- Tus afirmaciones deben basarse en pruebas, no en inferencias.
- No asumas que la compatibilidad con versiones anteriores es importante a menos que hayas confirmado con el miembro que el producto ya está en producción y se usa.`,
  "templates.relationshipAdvisor.instructions": `Ayuda al miembro a pensar con claridad sobre relaciones, amistades, comunicación, necesidades, límites y próximos pasos.

Averigua el estilo de apego y los rasgos de personalidad del miembro. Después, fundamenta tus respuestas en ese contexto para que conecten con él.

Separa lo que se dijo realmente de la interpretación; estás escuchando una sola versión. Ayuda al miembro a entender la perspectiva de la otra persona, teniendo en cuenta que puede actuar de forma distinta a él.

Si quiere compartir conversaciones, explícale que puedes leer capturas de pantalla, pero que todo lo que veas se comparte con OpenAI o Anthropic, según tu backend. Antes de que comparta algo sensible, explícale que los proveedores suelen tener un ajuste para excluir sus datos del entrenamiento y anímale a usarlo.

Conserva la voz del miembro en cualquier mensaje que ayudes a escribir o editar. Sin señales de IA: sin rayas, sin «no es X, es Y», sin añadir opiniones editoriales.

Otras cosas en las que puedes ayudar al miembro:

- Planificar citas.
- Sugerir ideas de regalos personalizados.`,
  "templates.jobSearchCoach.instructions": `Ayuda al miembro a evaluar por sí mismo su búsqueda de empleo.

- ¿Qué busca?
- ¿Cuáles son sus prioridades?
- ¿Cuáles son sus dificultades?
- ¿Cuáles son sus plazos?
- ¿En qué tipo de preparación debería centrarse?

Después, trabaja con él en una estrategia realista de búsqueda de empleo.

Cosas que puedes ofrecerte a hacer por él, si quiere:

- Buscar buenos recursos de preparación, dando preferencia a los gratuitos.
- Practicar preguntas con él y dar críticas constructivas. Sugiérele usar la conversión de voz a texto para sus respuestas. Dile que no se preocupe si algunas palabras no se transcriben bien; encontrarás la palabra correcta que suene de forma parecida o pedirás una aclaración si hace falta.
- Trabajar con él en sucesivas versiones de su currículum, pero dile que, para evitar que se marque como generado por IA, el texto final debe ser suyo.
- Mejorar o ampliar su portfolio.
- Crear una carpeta local para llevar el seguimiento de oportunidades y candidaturas, y/o configurar una App de panel de control registrada en Isomux.
- Investigar las empresas con las que tiene entrevistas para encontrar conexiones con su trayectoria.

Conserva la voz del miembro en cualquier texto que escribas o edites. Sin señales de IA: sin rayas, sin «no es X, es Y», sin añadir opiniones editoriales.

No envíes candidaturas ni contactes con nadie sin aprobación explícita.`,
  "templates.tripPlanner.instructions": `Ayuda al miembro a planificar viajes según sus intereses, fechas, presupuesto, ritmo y necesidades de accesibilidad.

Comprueba las normas de entrada, horarios de transporte, horarios de apertura, precios, tiempo y condiciones de reserva actuales antes de basarte en ellos; cambian a menudo.

Ayuda a planificar días realistas, con tiempo para desplazarse y descansar.

Cosas que puedes hacer por él:

- Investigar destinos y comparar opciones, mostrando los horarios y costes que justifican la recomendación.
- Dar a conocer al miembro actividades menos conocidas en su destino.
- Detectar conflictos en los detalles de las reservas y revisar el plan cuando cambie una limitación.
- Ofrecer buscar reservas y confirmaciones en su correo si habilita una integración. Claude y ChatGPT admiten integraciones con gmail: guíale para habilitarla, no reinventes la integración por tu cuenta.
- Crear una App de itinerario personalizada y registrarla en Isomux, para que la tenga en su teléfono durante el viaje. Si quiere, puede invitar a sus compañeros de viaje a su oficina de Isomux para que también vean la App del itinerario, o incluso te hagan preguntas directamente. Pero debe saber que sus compañeros de viaje podrían obtener acceso a otros agentes de las salas que puedan ver (y acceso por terminal a todo el sistema de archivos).`,
  "templates.receptionist.label": "Recepcionista de Isomux",
  "templates.receptionist.description": "Ayuda con Isomux y esta oficina.",
  "lobby.receptionistName": "Recepcionista",
  "lobby.welcome": "BIENVENIDOS",
  "lobby.poster": "LA OFICINA",
  "common.lobby": "Vestíbulo",
  "lobby.officeFallback": "la oficina",
  "lobby.directory": "DIRECTORIO",
  "lobby.employeeLine1": "EMPLEADO",
  "lobby.employeeLine2": "DEL MINUTO",
  "lobby.openChat": "{name} - haz clic para abrir el chat",
  "lobby.receptionist.open": "Abrir el chat con {name}",
  "lobby.jukebox.play": "Reproducir música",
  "lobby.jukebox.stop": "Parar la música",
  "lobby.jukebox.classical": "Clásica - haz clic para parar",
  "lobby.jukebox.jazz": "Jazz - haz clic para parar",
  "lobby.jukebox.lofi": "Lo-fi ambiental - haz clic para parar",
  "lobby.jukebox.house": "House - haz clic para parar",
  "lobby.jukebox.chip": "Chiptune - haz clic para parar",
  "lobby.jukebox.bossa": "Bossa nova - haz clic para parar",
  "membersChat.authorApi": "{name} · token de API",
  "membersChat.authorApiDevice": '{name} · token de API "{device}"',
  "membersChat.deleteAgain": "Haz clic de nuevo para eliminar",
  "membersChat.sure": "¿seguro?",
  "membersChat.loadFailed": "No se pudo cargar el chat",
  "membersChat.olderFailed": "No se pudieron cargar mensajes anteriores",
  "membersChat.uploadFailed": "error al subir",
  "membersChat.uploadStatus": "Error al subir ({status})",
  "membersChat.sendFailed": "No se pudo enviar",
  "membersChat.editFailed": "No se pudo editar",
  "membersChat.deleteFailed": "No se pudo eliminar",
  "membersChat.unreadCount.one": "Mensaje sin leer: {count}",
  "membersChat.unreadCount.other": "Mensajes sin leer: {count}",
  "membersChat.retry": "Reintentar",
  "membersChat.thumbsUp": "Me gusta",
  "membersChat.removeThumbsUp": "Quitar me gusta",
  "membersChat.reactors": "Me gusta: {count}",
  "membersChat.reactionFailed": "No se pudo actualizar la reacción",
  "apiCall.membersChat.thumbsUp": "Marcar me gusta en el chat de miembros",
  "membersChat.resize": "Cambiar el ancho del chat",
  "membersChat.hide": "Ocultar chat",
  "membersChat.reply": "Responder",
  "membersChat.cancelReply": "Cancelar respuesta",
  "membersChat.actions": "Acciones del mensaje",
  "membersChat.replyMissing":
    "El mensaje original se ha eliminado. Cancela la respuesta o elige otro mensaje.",
  "membersChat.pin": "Fijar",
  "membersChat.unpin": "Desfijar",
  "membersChat.pinned": "Fijados ({count})",
  "membersChat.pinFailed": "No se pudo actualizar el mensaje fijado",
  "apiCall.membersChat.pin": "Fijar mensaje del chat de miembros",
  "membersChat.title": "Chat de miembros",
  "membersChat.online": "{count} en línea",
  "membersChat.loadingOlder": "Cargando mensajes anteriores…",
  "membersChat.loadOlder": "Cargar anteriores",
  "membersChat.empty": "Todavía no hay nada. Solo las personas ven este chat.",
  "membersChat.edited": " · editado",
  "membersChat.uploading": "subiendo…",
  "membersChat.placeholder": "Escribe a los miembros…",

  "common.save": "Guardar",
  "common.saving": "Guardando…",
  "common.saved": "Guardado",
  "common.cancel": "Cancelar",
  "common.close": "Cerrar",
  "common.loading": "Cargando…",
  "common.loadingMemory": "Cargando la memoria…",
  "common.memory": "Memoria",
  "common.memorySize": "{size} / {cap} caracteres",
  "common.memoryEditorHint":
    "Este editor reescribe el archivo tal como se muestra. Usa una memoria por línea.",
  "common.saveFailed": "No se pudo guardar",
  "common.memoryConflict":
    "La memoria cambió desde que abriste esto: vuelve a abrir el diálogo para editar la última versión.",
  "common.memorySaveFailed": "No se pudo guardar la memoria",
  "common.unread": "sin leer",
  "common.roomFallback": "Sala {number}",
  "common.nextConversation":
    "Los cambios se aplican en la siguiente conversación.",
  "common.schedule": "Programación",
  "common.discardPrompt": "¿Descartar los cambios sin guardar?",
  "common.delete": "Eliminar",
  "common.confirmQuestion": "¿Confirmar?",
  "nav.tasksShortcut": "Tareas (t)",
  "nav.appsShortcut": "Apps (a)",
  "nav.integrationsShortcut": "Integraciones (i)",
  "nav.settingsShortcut": "Ajustes (s)",
  "common.moreActions": "Más acciones",
  "common.settings": "Ajustes",
  "common.theme": "Tema",
  "common.checking": "Comprobando…",
  "common.copied": "Copiado",
  "common.copy": "Copiar",
  "common.device": "Dispositivo",
  "common.discard": "Descartar",
  "common.justNow": "ahora mismo",
  "common.name": "Nombre",
  "common.noRooms": "Aún no hay salas.",
  "common.prefix": "Prefijo",
  "common.revoke": "Revocar",
  "common.instructions": "Instrucciones",
  "common.role": "Rol",
  "common.rooms": "Salas",
  "common.signOut": "Cerrar sesión",
  "common.user": "Miembro",
  "common.automations": "Automatizaciones",
  "common.apps": "Apps",
  "common.changeTheme": "Cambiar el tema",

  "preferences.intro":
    "Tu idioma te sigue a todos los dispositivos desde los que inicias sesión.",
  "preferences.language": "Idioma",
  "preferences.languageHint":
    "El idioma de la interfaz, de lo que escriben tus agentes y de la entrada de voz y la lectura en voz alta. Los agentes lo aplican en su siguiente conversación.",
  "preferences.saved": "Guardado.",
  "preferences.saveFailed": "No se pudo guardar",

  "settings.selectHint": "Elige un ajuste de la lista",
  "settings.profilesNote":
    "Los perfiles de miembro se guardan en el servidor. Tus notificaciones y credenciales te siguen entre dispositivos.",
  "settings.signOutHint": "Cierra la sesión de este dispositivo",
  "settings.you": "(tú)",
  "settings.sidebar.office": "Oficina",
  "settings.sidebar.access": "Acceso",
  "settings.sidebar.invites": "Invitaciones",
  "settings.sidebar.sessions": "Sesiones",
  "settings.sidebar.usage": "Uso",
  "settings.sidebar.storage": "Almacenamiento",
  "settings.sidebar.language": "Idioma",
  "settings.sidebar.housekeeping": "Mantenimiento",
  "settings.sidebar.updates": "Actualizaciones",
  "settings.sidebar.profile": "Perfil",
  "settings.sidebar.apiTokens": "Tokens de API",
  "settings.sidebar.signInLinks": "Enlaces de inicio de sesión",
  "settings.sidebar.deviceLabel": "Etiqueta del dispositivo",
  "settings.sidebar.members": "Miembros",
  "settings.members.editHint":
    "Solo el propio miembro y los propietarios de la oficina pueden editar un miembro",
  "settings.members.onlineNow": "En línea ahora",
  "settings.members.online": "en línea",
  "settings.members.onlineSessions.one": "en línea · {count} sesión",
  "settings.members.onlineSessions.other": "en línea · {count} sesiones",
  "settings.members.lastSeen": "visto por última vez {when}",
  "settings.members.newMember": "Nuevo miembro",
  "settings.members.create": "Crear miembro",
  "settings.members.neverSignedIn": "nunca ha iniciado sesión",
  "settings.role.officeOwner": "Propietario de la oficina",
  "settings.role.officeOwnerExplanation":
    "Puede acceder a todas las salas, invitar a miembros y gestionar el acceso y las sesiones de los miembros.",
  "settings.role.owner": "propietario de la oficina",
  "settings.role.member": "miembro",
  "settings.role.ownerHint":
    "Propietario - puede invitar miembros, revocar sesiones y fijar el acceso a salas de cada miembro",
  "settings.role.memberHint":
    "Miembro - puede actuar en las salas que el propietario de la oficina le permitió; no puede invitar ni revocar",

  "settings.profile.identity": "Identidad",
  "settings.profile.displayName": "Nombre visible",
  "settings.profile.accessHint":
    "Acceso: salas que este miembro puede ver y en las que puede actuar (lo gestiona el propietario de la oficina).",
  "settings.profile.viewHint":
    "Mostradas: cuáles de tus salas accesibles aparecen en tu vista. Notificaciones: sonido cuando un agente de esa sala responde a tu mensaje. Push: una notificación en tus dispositivos cuando un agente de esa sala responde a tu mensaje. Una sala debe estar mostrada para notificar.",
  "settings.profile.roomColumn": "Sala",
  "settings.profile.accessColumn": "Acceso",
  "settings.profile.displayedColumn": "Mostrada",
  "settings.profile.notificationsColumn": "Notificaciones",
  "settings.profile.devicesColumn": "Push",
  "settings.profile.accessTo": "Acceso a {room}",
  "settings.profile.display": "Mostrar {room}",
  "settings.profile.tuckedColumn": "Recogida",
  "settings.profile.tuck": "Recoger {room}",
  "settings.profile.notificationsFor": "Notificaciones de {room}",
  "settings.profile.devicesFor": "Notificaciones push de {room}",
  "settings.profile.promptConflict":
    "Las instrucciones especiales cambiaron en otro lugar. Tu borrador se conserva. Revisa el texto actual antes de volver a guardar.",
  "settings.profile.currentPrompt": "Instrucciones especiales actuales",
  "settings.profile.profilePrompt": "Instrucciones especiales",
  "settings.profile.profilePromptHint":
    "(se inyecta en el prompt de sistema de los agentes que posees; los agentes de otros miembros pueden consultarlo si necesitan contexto sobre ti)",
  "settings.profile.profilePromptTitle": "{user} · Instrucciones especiales",
  "settings.profile.profilePromptExpandedHint":
    "Se inyecta en el prompt de sistema de los agentes que posee este miembro; los agentes de otros miembros pueden consultarlo si necesitan contexto sobre él.",
  "settings.profile.profilePromptPlaceholder":
    "Unas notas para los agentes sobre quién eres, tu rol, cómo te gusta colaborar…",
  "settings.profile.memoryHint":
    "(hechos duraderos sobre este miembro; reescribe el archivo tal como se muestra - una memoria por línea; {size} / {cap})",
  "settings.profile.memoryTitle": "{user} · Memoria",
  "settings.profile.memoryPlaceholder":
    "Alguna memoria relevante para este miembro",
  "settings.profile.appearance": "Apariencia",
  "settings.profile.avatarHint":
    "(tu fantasma en la escena de la oficina; los demás miembros lo ven junto al agente que estás viendo)",
  "settings.profile.deleteHint": "Eliminar este miembro",
  "settings.profile.deleteFailed": "No se pudo eliminar",
  "settings.profile.roomListFailed":
    "No se pudo confirmar tu lista de salas; Mostradas no se guardó.",

  "settings.office.title": "Ajustes de la oficina",
  "settings.office.intro": "Ajustes que se aplican a todas las salas.",
  "settings.office.viewOnly":
    "Solo lectura. Solo los propietarios de la oficina pueden editar los ajustes de toda la oficina.",
  "settings.office.name": "Nombre de la oficina",
  "settings.office.nameHint":
    "(opcional, se muestra en la pestaña del navegador)",
  "settings.office.namePlaceholder": "Oficina de Nil",
  "settings.office.rulesHint": "(se añade al prompt de sistema de cada agente)",
  "settings.office.rulesTitle": "Instrucciones de la oficina",
  "settings.office.rulesExpandedHint":
    "Se añade al prompt de sistema de cada agente. Los cambios se aplican en la siguiente conversación.",
  "settings.office.rulesPlaceholder":
    "p. ej. Escribe siempre tests. Usa TypeScript. Sé conciso.",
  "settings.office.memoryHint":
    "(hechos duraderos de toda la oficina; líneas en bruto; {size} / {cap})",
  "settings.office.memoryTitle": "Memoria de la oficina",
  "settings.office.memoryPlaceholder":
    "Alguna memoria relevante para toda la oficina",
  "settings.office.reloadFailed":
    "Guardado, pero esta página no pudo recargar la oficina. Elige otra fila y vuelve para seguir editando.",
  "settings.office.conflict":
    "Los ajustes de la oficina cambiaron en otro sitio desde que se cargó esta página. Elige otra fila y vuelve para cargar la última versión.",
  "settings.office.memberUsageCap": "Marcar el ritmo de uso de los miembros",
  "settings.office.memberUsageCapHint":
    "Los turnos de los miembros con la sesión de toda la oficina se detienen en un límite que sube cada día de la semana, hasta la parte de los miembros.",
  "settings.office.memberUsageShare":
    "Parte de los miembros del límite semanal",
  "settings.office.memberUsageShareOption": "{share} %",
  "settings.office.memberUsageWeekly":
    "{provider}: {used} % usado; hoy los miembros se detienen en el {line} %.",
  "settings.office.memberUsageNoLimit":
    "{provider}: la sesión de toda la oficina no tiene límite semanal. Los miembros no tienen tope.",
  "settings.office.memberUsageFailed":
    "{provider}: no se pudo leer el uso semanal. Los miembros no tienen tope.",
  "settings.office.memberUsageLoading": "{provider}: leyendo el uso semanal…",

  "settings.room.title": "{room} · Ajustes",
  "settings.room.intro":
    "La rejilla de la pared, la tecla s y un doble clic en la pestaña de la sala abren esta página.",
  "settings.room.namePlaceholder": "Nombre de la sala",
  "settings.room.backRoom": "Trastienda",
  "settings.room.backRoomHint": "Más de {count} agentes, tras una trampilla.",
  "settings.room.cwdHint": "Los agentes nuevos de esta sala empiezan aquí.",
  "settings.room.backRoomInUse.one":
    "{count} agente está en la trastienda. Sácalo primero.",
  "settings.room.backRoomInUse.other":
    "{count} agentes están en la trastienda. Sácalos primero.",
  "settings.room.prompt": "Instrucciones",
  "settings.room.promptHint":
    "(opcional, se añade después de las instrucciones de la oficina)",
  "settings.room.promptTitle": "{room} · Instrucciones de la sala",
  "settings.room.promptPlaceholder":
    "p. ej. Estás en la sala de Marketing. Sigue la voz de nuestra marca.",
  "settings.room.promptNote":
    "Los cambios se aplican en la siguiente conversación. Define las variables de entorno en la página Integraciones.",
  "settings.room.memoryHint":
    "(hechos duraderos de esta sala; líneas en bruto; {size} / {cap})",
  "settings.room.memoryTitle": "{room} · Memoria",
  "settings.room.memoryPlaceholder": "Alguna memoria relevante para esta sala",
  "settings.room.conflict":
    "Los ajustes de la sala cambiaron en otro sitio desde que se cargó esta página. Elige otra fila y vuelve para cargar la última versión.",
  "settings.room.deleteEmpty": "Eliminar la sala vacía",
  "settings.room.yourView": "Tu vista",

  "settings.theme.intro":
    "Se guarda en este navegador. También puedes hacer clic en la ventana de la oficina para recorrer los temas sin abrir esta página.",

  "settings.device.intro":
    'Se guarda en este navegador. Dice a los agentes en qué dispositivo estás (por ejemplo "Móvil" frente a "Portátil") para que adapten sus respuestas.',
  "settings.device.label": "Etiqueta del dispositivo",
  "settings.device.optional": "(opcional)",
  "settings.device.placeholder": "Móvil, Portátil, …",

  "settings.devices.title": "Enlaces de inicio de sesión",
  "settings.devices.outstandingLinks": "Enlaces de dispositivo pendientes",
  "settings.devices.activeSessions": "Mis sesiones activas",
  "settings.devices.generateHint":
    "Genera un enlace de un solo uso para iniciar sesión con otro de tus dispositivos en tu cuenta. El enlace caduca en 1 hora; generar uno nuevo sustituye al anterior.",
  "settings.devices.generateWarning":
    "Cualquiera con el enlace puede iniciar sesión como tú hasta que caduque o se use - trátalo como una contraseña de un solo uso y ábrelo solo en tu propio dispositivo.",
  "settings.devices.generating": "Generando…",
  "settings.devices.generate": "Generar enlace de dispositivo",
  "settings.devices.generateFailed":
    "No se pudo generar el enlace de dispositivo",

  "settings.update.newRelease": "Nueva versión disponible",
  "settings.update.upToDateTitle": "Actualizado",
  "settings.update.upToDate": "Esta oficina está actualizada.",
  "settings.update.releaseNotesParen": "(notas de la versión)",
  "settings.update.githubParen": "(GitHub)",
  "settings.update.toUpdate": "Para actualizar:",
  "settings.update.stepPull": "Descarga los últimos cambios",
  "settings.update.stepInstall": "Ejecuta <code>bun install</code>",
  "settings.update.stepRestart":
    "Reinicia isomux para que la actualización se aplique. Desarrollo: <code>bun run dev</code>. Servicio de usuario: <code>systemctl --user restart isomux</code>. Servicio de sistema: <code>sudo systemctl restart isomux</code>.",
  "settings.update.tip":
    "Consejo: pulsa el botón de copiar para copiar este aviso al portapapeles y luego pide a cualquier agente que se encargue.",
  "settings.update.stepRefresh":
    "Recarga el navegador después de que se reinicie el servidor.",
  "settings.update.runningOn": "Estás en <code>{version}</code>",
  "settings.update.unknownVersion": "una versión desconocida",
  "settings.update.latestRelease":
    "Última versión: <code>{tag}</code>{published}",
  "settings.update.releaseNotes": "notas de la versión",
  "settings.update.restartWarning":
    "Actualizar reinicia el servidor e interrumpe a todos los agentes.",
  "settings.update.busyNone":
    "Ningún agente está a mitad de tarea ahora mismo.",
  "settings.update.busy.one":
    "{count} agente está a mitad de tarea ahora mismo.",
  "settings.update.busy.other":
    "{count} agentes están a mitad de tarea ahora mismo.",
  "settings.update.busyUnavailable":
    "El recuento de agentes ocupados no está disponible ahora mismo.",
  "settings.update.imageRender":
    "Para actualizar, usa el control de despliegue manual del servicio web en Render.",
  "settings.update.imageRelease":
    "Para actualizar, despliega la imagen de la versión {tag}.",
  "settings.update.imageHomebrew":
    "Para actualizar, ejecuta <code>brew upgrade isomux</code> y después <code>brew services restart isomux</code>.",
  "settings.update.updateGuide": "Guía de actualización",
  "settings.update.ownerOnly":
    "Un propietario de la oficina puede aplicarla desde este diálogo.",
  "settings.update.updateNow": "Actualizar ahora",
  "settings.update.updateNowBusy": "Actualizar ahora ({count} ocupados)",
  "settings.update.updating": "Actualizando…",
  "settings.update.gotIt": "Entendido",
  "settings.update.lastUpdate": "Última actualización, {date}",

  "update.screen.title": "Actualizando isomux",
  "update.screen.prepare": "Preparando",
  "update.screen.install": "Instalando",
  "update.screen.restart": "Reiniciando",
  "update.screen.requested": "Esperando al actualizador.",
  "update.screen.done": "Esta oficina ahora ejecuta {version}.",
  "update.screen.failed":
    "La actualización no terminó. Esta oficina ejecuta {version}.",
  "update.screen.reload": "Recargar",
  "update.screen.hide": "Ocultar",
  "update.outcome.title": "Notas de la actualización",

  "lazyPanel.loadFailed": "No se pudo cargar.",
  "lazyPanel.reload": "Recargar",

  "settings.usage.title": "Uso de la oficina",
  "settings.usage.intro":
    "Los límites del plan de suscripción no se muestran aquí. Esta página informa del uso de tokens y del coste estimado que registra Isomux.",
  "settings.usage.scoped":
    "Limitado a las salas a las que tienes acceso. El uso de las programaciones no se incluye.",
  "settings.usage.loadFailed": "No se pudo cargar el uso.",
  "settings.usage.agents": "Uso por agente",
  "settings.usage.rooms": "Uso por sala",
  "settings.usage.roomsNote":
    "Los agentes eliminados cuentan en la última sala en la que estuvieron.",
  "settings.usage.roomColumn": "Sala",
  "settings.usage.deleted": "eliminada",
  "settings.usage.schedules": "Uso por programación",
  "settings.usage.total": "Total",
  "settings.usage.officeTotal": "Total de la oficina",
  "settings.usage.inSession": "Entrada (ses.)",
  "settings.usage.outSession": "Salida (ses.)",
  "settings.usage.costSession": "$ (ses.)",
  "settings.usage.inLifetime": "Entrada (total)",
  "settings.usage.outLifetime": "Salida (total)",
  "settings.usage.costLifetime": "$ (total)",
  "settings.usage.cacheHit": "{count} ({hit} % de aciertos)",

  "settings.storage.title": "Almacenamiento de la oficina",
  "settings.storage.category.transcripts": "Transcripciones de conversaciones",
  "settings.storage.category.tokenLogs": "Conversaciones de tokens de API",
  "settings.storage.category.terminalRecordings": "Grabaciones de terminales",
  "settings.storage.category.attachments": "Adjuntos del chat",
  "settings.storage.category.sessionMetadata": "Metadatos de sesión",
  "settings.storage.category.codexHome": "Directorio de Codex",
  "settings.storage.category.providerHomes":
    "Directorios personales de proveedores",
  "settings.storage.category.cronjobs": "Historial de programaciones",
  "settings.storage.category.webhooks": "Webhooks",
  "settings.storage.category.otherState": "Todo lo demás",
  "settings.storage.category.backups": "Copias de seguridad",
  "settings.storage.category.updateSnapshots": "Instantáneas de actualización",
  "settings.storage.skip.tooRecent":
    "más recientes que el límite de antigüedad",
  "settings.storage.skip.keepNewest":
    "entre las más recientes que se conservan para su agente",
  "settings.storage.skip.activeSession":
    "pertenecen a una conversación que sigue activa",
  "settings.storage.skip.forkAncestor":
    "otra conversación se bifurcó a partir de ellas",
  "settings.storage.skip.referenced":
    "aún se muestran en una conversación que puedes leer",
  "settings.storage.skip.liveRecording":
    "pertenecen a un terminal que sigue abierto",
  "settings.storage.skip.queueStateUnknown":
    "esperan en una cola de mensajes que no se pudo leer",
  "settings.storage.measureFailed": "No se pudo medir el almacenamiento.",
  "settings.storage.previewFailed": "La solicitud de limpieza falló.",
  "settings.storage.deleteFailed": "La solicitud de borrado falló.",
  "settings.storage.deleteDidNotRun":
    "El borrado no se ejecutó. No se eliminó nada.",
  "settings.storage.leaveConfirm":
    "Aún hay una limpieza en marcha. Si sales ahora pierdes el único informe de lo que borró. ¿Salir de todos modos?",
  "settings.storage.leave": "Salir",
  "settings.storage.deleteSection": "Borrar archivos antiguos",
  "settings.storage.deleteWarningLead":
    "Esto borra archivos de esta máquina de forma permanente.",
  "settings.storage.deleteWarningBody":
    "No hay deshacer ni papelera. Las conversaciones y los adjuntos antiguos solo se borran cuando ejecutas esta limpieza.",
  "settings.storage.whatToDelete": "Qué borrar",
  "settings.storage.olderThan": "Más antiguos que",
  "settings.storage.daysHint":
    "días. Todo lo tocado más recientemente se conserva.",
  "settings.storage.keepPerAgent": "Conservar siempre, por agente",
  "settings.storage.keepHint":
    "conversaciones más recientes de cada agente vivo, por antiguas que sean. 0 no conserva ninguna por ese criterio.",
  "settings.storage.preview": "Previsualizar lo que se borraría",
  "settings.storage.measuring": "Midiendo…",
  "settings.storage.onDisk": "Qué hay en disco",
  "settings.storage.totalSplit":
    "<strong>{total} en total</strong> - {state} de estado de la oficina, más {outside} fuera de él.",
  "settings.storage.totalAllState":
    "<strong>{total} en total</strong>, todo estado de la oficina.",
  "settings.storage.measured": "Medido {when}.",
  "settings.storage.totalOfficeState": "Total del estado de la oficina",
  "settings.storage.outsideOfficeState": "Fuera del estado de la oficina",
  "settings.storage.none": "ninguno",
  "settings.storage.outsideNote":
    "Las copias de seguridad y las instantáneas de actualización están fuera del directorio de estado de la oficina, así que se listan después de su subtotal. “ninguno” significa que esa ubicación no está configurada en esta máquina.",
  "settings.storage.backupUnavailable":
    "Estado de las copias de seguridad no disponible.",
  "settings.storage.noBackupYet":
    "Aún no se ha hecho ninguna copia de seguridad.",
  "settings.storage.lastBackupOk":
    "Última copia de seguridad {when}, correcta.",
  "settings.storage.lastBackupFailed":
    "Última copia de seguridad {when} FALLIDA.",
  "settings.storage.lastBackupFailedWith":
    "Última copia de seguridad {when} FALLIDA: {error}",
  "settings.storage.backupEvery.one": "Una nueva cada {count} hora.",
  "settings.storage.backupEvery.other": "Una nueva cada {count} horas.",
  "settings.storage.oldBackupsStay":
    "Las copias anteriores se quedan en <code>{dir}</code>.",
  "settings.storage.backupInterval": "Copia cada",
  "settings.storage.backupHours": "horas",
  "settings.storage.backupCopies": "Copias que se guardan",
  "settings.storage.backupFolder": "Carpeta",
  "settings.storage.backupFolderHint":
    "Déjala vacía para usar la carpeta predeterminada.",
  "settings.storage.backupFolderFromEnv": "ISOMUX_BACKUP_DIR fija la carpeta.",
  "settings.storage.backupSaveFailed":
    "No se pudo guardar la configuración de las copias de seguridad.",
  "settings.storage.compressSection": "Comprimir conversaciones antiguas",
  "settings.storage.compressHint":
    "Las conversaciones antiguas ocupan menos espacio y se leen igual.",
  "settings.storage.compress": "Comprimir",
  "settings.storage.compressing": "Comprimiendo…",
  "settings.storage.compressNothing": "No hay nada que comprimir.",
  "settings.storage.compressedResult.one":
    "Se comprimió {count} conversación, de {before} a {after}.",
  "settings.storage.compressedResult.other":
    "Se comprimieron {count} conversaciones, de {before} a {after}.",
  "settings.storage.compressRefused.one": "{count} se dejó como estaba.",
  "settings.storage.compressRefused.other": "{count} se dejaron como estaban.",
  "settings.storage.compressFailed": "La solicitud de compresión falló.",
  "settings.storage.backupKeeping":
    "Se conservan {retention} en <code>{destDir}</code>.",
  "settings.storage.planCount":
    "Se borrarían {count} {target}, liberando {size}.",
  "settings.storage.planEmpty":
    "Nada coincide. Ninguna de las {target} es tan antigua como para borrarla.",
  "settings.storage.planPreviewNote":
    "Aún no se ha borrado nada - esto es una previsualización.",
  "settings.storage.skippedRow": "{count} conservadas ({size}): {reason}",
  "settings.storage.sampleRow": "{path} - {size}, {age} d de antigüedad",
  "settings.storage.sampleMore": "…y {count} más.",
  "settings.storage.queueUnreadable":
    "Isomux no pudo leer la cola de mensajes pendientes, así que no puede saber qué adjuntos aún deben entregarse con mensajes pendientes. No se borrará nada hasta que se pueda leer de nuevo.",
  "settings.storage.deleteCount": "Borrar {count} {target} de forma permanente",
  "settings.storage.cannotUndo": "Esto no se puede deshacer.",
  "settings.storage.confirmBody":
    "La previsualización encontró {size} de {target} para borrar de esta máquina. Una copia de seguridad puede contener otra copia, si se hizo después de escribir estos archivos. Isomux vuelve a escanear antes de borrar. Los archivos que ya no coinciden o no pasan una comprobación de seguridad se conservan, así que el recuento final puede diferir de esta previsualización.",
  "settings.storage.confirmPlaceholder": "Escribe DELETE para confirmar",
  "settings.storage.deleting": "Borrando…",
  "settings.storage.deletePermanently": "Borrar de forma permanente",
  "settings.storage.aborted": "Se detuvo antes de borrar nada: {reason}",
  "settings.storage.deletedResult":
    "Se borraron {count} archivos, liberando {size}.",
  "settings.storage.refused":
    "{count} no se pudieron eliminar y se dejaron como estaban.",

  "settings.access.none": "Ninguna.",
  "settings.access.expired": "caducada",
  "settings.access.expiresUnderHour": "0 h",
  "settings.access.localTime": "{time} local",
  "settings.access.inviteUrl": "URL de invitación",
  "settings.access.copyUrl": "Copiar la URL",
  "settings.access.urlCopied": "¡Copiada!",
  "settings.access.clipboardBlocked":
    "Portapapeles bloqueado. La URL de arriba está seleccionada - cópiala a mano.",
  "settings.access.sendUrl":
    "Envía esta URL a la persona invitada. Es de un solo uso: al abrirla en su dispositivo, entra. La URL se muestra una vez - cópiala ahora.",
  "settings.access.signInUrl": "URL de inicio de sesión",
  "settings.access.openUrlSelf": "La URL se muestra una vez - cópiala ahora.",

  "settings.invites.intro":
    "Un enlace de inicio de sesión inicia la sesión de un dispositivo como un miembro existente. Para invitar a un miembro nuevo, créalo primero en <i>Miembros</i>.",
  "settings.invites.linkHint":
    "Envía el enlace en privado. Caduca en 24 h, y un enlace nuevo sustituye al anterior del miembro.",
  "settings.invites.createLink": "Crear enlace de inicio de sesión",
  "settings.invites.creatingLink": "Creando…",
  "settings.invites.createLinkFailed":
    "No se ha podido crear el enlace de inicio de sesión",
  "preAuth.invite.changeLater":
    "Puedes cambiar tu nombre e idioma más adelante en Ajustes.",
  "preAuth.invite.nameTaken": "Ese nombre ya está en uso. Elige otro.",
  "preAuth.invite.errorLanguage": "Elige un idioma.",
  "preAuth.invite.newMember": "Nuevo miembro",
  "settings.invites.selectUser": "Elige a alguien…",
  "settings.invites.outstanding": "Invitaciones pendientes",
  "settings.invites.columnFor": "Para",
  "settings.invites.columnExpires": "Caduca",
  "settings.invites.bootstrap": "(inicial)",

  "settings.sessions.intro":
    "Dispositivos que han entrado en esta oficina, de todas las personas. Revocar una sesión saca a ese dispositivo. Quien es nuevo recibe una invitación desde la sección Invitaciones; quien ya tiene cuenta añade dispositivos desde <i>Enlaces de inicio de sesión</i>.",
  "settings.sessions.columnLastSeen": "Visto por última vez",
  "settings.sessions.columnCreated": "Creada",
  "settings.sessions.currentSession": "Sesión actual",
  "settings.sessions.currentSessionHint":
    "Usa Cerrar sesión al final de la barra lateral para terminar tu sesión actual.",
  "settings.sessions.expiryInactivity": "Caduca por inactividad",
  "settings.sessions.expiryLatest": "Caduca como muy tarde",

  "settings.externalAccess.managed":
    "Hosted Isomux gestiona la dirección de esta oficina; no se puede cambiar.",
  "settings.externalAccess.intro":
    "Controla si se puede llegar a esta oficina desde fuera de esta máquina. Los enlaces de invitación y los dispositivos que han entrado están en las secciones Invitaciones y Sesiones.",
  "settings.externalAccess.title": "Acceso externo",
  "settings.externalAccess.loopback":
    "Ahora mismo solo por loopback. Se llega a la oficina desde esta máquina, o desde otras a través de un túnel SSH.",
  "settings.externalAccess.external":
    "Ahora mismo acepta conexiones externas. Se llega a la oficina desde cualquier sitio donde resuelva la URL pública.",
  "settings.externalAccess.enable": "Activar el acceso externo",
  "settings.externalAccess.publicUrl": "URL pública",
  "settings.externalAccess.urlHint":
    "Patrón: {pattern} (la dirección que abrirás desde el portátil o el móvil). Guardar no cambia por sí solo la interfaz donde escucha el servidor - reinicia isomux para aplicarlo.",
  "settings.externalAccess.discardPrompt":
    "¿Descartar los cambios de acceso externo sin guardar?",
  "settings.externalAccess.updateFailed":
    "No se han podido actualizar los ajustes",
  "settings.externalAccess.restartNote":
    "Guardado. Reinicia isomux para que la nueva interfaz de escucha tenga efecto. Servicio de usuario: <code>systemctl --user restart isomux</code>. Servicio del sistema: <code>sudo systemctl restart isomux</code>.",
  "settings.externalAccess.signInAfterRestart":
    "Después del reinicio, abre esta URL en el dispositivo que quieras usar desde la dirección pública. (Caduca 1 hora después de emitirla.)",

  "settings.apiTokens.intro":
    "Maneja tu oficina desde scripts y automatizaciones, y lee lo que responden tus agentes. Un token tiene tus mismas capacidades, salvo cambiar quién puede entrar en la oficina. Mira la <link>guía de la API para desarrollo</link> para todo lo que puede hacer un token.",
  "settings.apiTokens.howToUse": "Cómo se usa",
  "settings.apiTokens.namePlaceholder": "Script del portátil",
  "settings.apiTokens.expiresAfter": "Caduca al cabo de",
  "settings.apiTokens.unlimited": "Sin límite",
  "settings.apiTokens.creating": "Creando…",
  "settings.apiTokens.create": "Crear el token",
  "settings.apiTokens.copyNow": "Copia este token ahora",
  "settings.apiTokens.shownOnce": "No se volverá a mostrar.",
  "settings.apiTokens.empty": "No hay tokens de API.",
  "settings.apiTokens.neverExpires": "no caduca nunca",
  "settings.apiTokens.expiresOn": "caduca el {date}",
  "settings.apiTokens.lastRequest": "Última petición autenticada: {when}",
  "settings.apiTokens.about": "sobre el {date}",
  "settings.apiTokens.never": "nunca",
  "settings.apiTokens.loadFailed": "No se han podido cargar los tokens de API",
  "settings.apiTokens.createFailed": "No se ha podido crear el token de API",
  "settings.apiTokens.revokeFailed": "No se ha podido revocar el token de API",

  "settings.connections.refresh": "Actualizar",
  "settings.connections.refreshing": "Actualizando…",
  "settings.connections.checkFailed":
    "No se han podido comprobar las cuentas de proveedor.",
  "settings.secrets.loadFailed": "No se pudieron cargar los secretos.",
  "settings.secrets.saveFailed": "No se pudo guardar el secreto.",
  "settings.secrets.formAuthorization": "Cabecera Authorization",
  "settings.secrets.formHeaderNamed": "Cabecera {header}",
  "settings.secrets.rotate": "Reemplazar el valor",
  "settings.secrets.saveValue": "Guardar el valor",
  "settings.secrets.reissue": "Nuevo sustituto",
  "settings.secrets.reissueConfirm":
    "El sustituto actual de {name} deja de funcionar ahora. Los agentes reciben el nuevo en su próximo inicio.",
  "settings.secrets.preset": "Servicio",
  "settings.secrets.presetCustom": "Otro",
  "settings.secrets.name": "Nombre",
  "settings.secrets.value": "Valor",
  "settings.secrets.valuePlaceholder": "Pega el valor",
  "settings.secrets.hosts": "Hosts que pueden recibirlo, uno por línea",
  "settings.connections.note": "Nota para los agentes",
  "settings.connections.notePlaceholder": "Para qué deben usarlo los agentes",
  "settings.connections.error.note":
    "La nota debe tener como máximo 1000 caracteres de texto sin formato.",
  "settings.secrets.vouch":
    "Indica solo hosts de confianza: al guardar, garantizas que nunca devuelven la credencial.",
  "settings.secrets.headerName": "Nombre de la cabecera",
  "settings.secrets.error.name":
    "Usa letras, dígitos y guiones bajos en el nombre, y no empieces con un dígito.",
  "settings.secrets.error.reservedName":
    "La oficina define este nombre por sí misma. Elige otro nombre.",
  "settings.secrets.error.modelKey":
    "Las claves de API de modelos van en Variables: los agentes no pueden iniciar sesión con un secreto.",
  "settings.secrets.error.value":
    "El valor debe tener entre 8 caracteres y 16 KiB de ASCII imprimible, sin espacios al principio ni al final.",
  "settings.secrets.error.hosts":
    "Indica de 1 a 20 nombres de host como api.github.com, sin https://, puerto ni ruta.",
  "settings.secrets.error.header":
    "Escribe un nombre de cabecera como x-api-key.",
  "settings.secrets.error.neverListed":
    "{host} nunca recibe un secreto: los hosts de modelos y de registros de paquetes están en la lista de exclusión.",
  "settings.secrets.error.exists": "Ya existe un secreto con este nombre.",
  "settings.secrets.error.apps": "Una app ya no existe o es de otro miembro.",
  "settings.secrets.error.appClash":
    "Una de estas apps ya lee un secreto con este nombre.",
  "settings.connections.bedrockHint":
    "¿Quieres conectar Bedrock? Lee <link>aquí</link>.",
  "settings.mcpServers.loadFailed": "No se pudieron cargar los servidores MCP.",
  "settings.mcpServers.saveFailed": "No se pudo guardar el servidor MCP.",
  "settings.mcpServers.add": "Añadir un servidor MCP",
  "settings.mcpServers.name": "Nombre",
  "settings.mcpServers.clientId": "ID de cliente (opcional)",
  "settings.mcpServers.clientSecret": "Secreto de cliente (opcional)",
  "settings.mcpServers.signIn": "Iniciar sesión",
  "settings.mcpServers.signInAgain": "Volver a iniciar sesión",
  "settings.mcpServers.signInDone": "Sesión iniciada en el servidor MCP.",
  "settings.mcpServers.signInFailed":
    "No se pudo iniciar sesión. Inténtalo de nuevo.",
  "settings.mcpServers.signInError.clientNeeded":
    "Este servidor no registra clientes. Introduce un ID de cliente.",
  "settings.mcpServers.signInError.redirectRefused":
    "El servidor de autorización rechazó la dirección de esta oficina. Algunos servidores solo aceptan direcciones https o localhost.",
  "settings.mcpServers.signInError.metadata":
    "Los datos de inicio de sesión del servidor faltan o no coinciden con el servidor.",
  "settings.mcpServers.signInError.secretExists":
    "Ya existe un secreto llamado {name} en este ámbito. Cámbiale el nombre o elimínalo y vuelve a iniciar sesión.",
  "settings.mcpServers.signInError.expired":
    "El inicio de sesión tardó demasiado. Inténtalo de nuevo.",
  "settings.mcpServers.signInError.wrongMember":
    "Otro miembro empezó este inicio de sesión.",
  "settings.mcpServers.signInError.denied": "Se canceló el inicio de sesión.",
  "settings.connections.list.mcpSignIn": "Excluido: sin sesión iniciada",
  "settings.connections.list.mcpSignInAgain":
    "Excluido: vuelve a iniciar sesión",
  "settings.mcpServers.tokenPlaceholder": 'Solo el token, sin "Bearer"',
  "settings.mcpServers.error.name":
    "Usa hasta 24 letras minúsculas, dígitos y guiones, con una letra o un dígito en cada extremo.",
  "settings.mcpServers.error.url":
    "Escribe una URL https:// sin usuario, contraseña ni #fragmento. Con credencial, usa el puerto predeterminado. http:// solo funciona para localhost, sin credencial.",
  "settings.mcpServers.error.exists":
    "Ya existe un servidor MCP con este nombre.",
  "settings.mcpServers.error.secretNotFound": "Ese secreto no existe.",
  "settings.mcpServers.error.secretHost":
    "El secreto no incluye {host}. Añade el host al secreto o elige otro.",
  "settings.connections.list.engineMcpUser":
    "Todos los agentes de Claude con el mismo inicio de sesión de Claude",
  "settings.connections.list.mcpCredentialNamed": "Credencial: {name}",
  "settings.connections.list.mcpSecretMissing": "Excluido: falta su secreto",
  "settings.connections.list.mcpSecretHost":
    "Excluido: su secreto no incluye {host}",
  "settings.connections.list.mcpOverridden":
    "Tu propio servidor MCP con este nombre lo sustituye para tus agentes.",
  "settings.connections.list.setInClaudeUser":
    "Definido en la configuración de usuario de Claude",
  "settings.connections.list.setInClaudeLocal":
    "Definido en la configuración local de Claude para {folder}",
  "settings.connections.list.setInProject": "Definido en {file}",
  "settings.connections.test.button": "Probar",
  "settings.connections.test.running": "Probando…",
  "settings.connections.test.noHostTest": "Sin prueba para sus hosts",
  "settings.connections.test.works": "Funciona",
  "settings.connections.test.help.github":
    "Isomux llamó a la API /user de GitHub con este secreto, y GitHub lo aceptó como la cuenta que se muestra.",
  "settings.connections.test.help.stripe":
    "Isomux llamó a la API /v1/account de Stripe con este secreto, y Stripe lo aceptó como la cuenta que se muestra.",
  "settings.connections.test.help.fly":
    "Isomux envió este secreto con una consulta viewer a la API GraphQL de Fly.io, y Fly.io lo aceptó como la cuenta que se muestra.",
  "settings.connections.test.help.mcp":
    "Isomux se conectó a este servidor como lo hace un agente y listó sus herramientas.",
  "settings.connections.test.help.claude":
    "Isomux inició Claude Code con este inicio de sesión, y Claude Code indicó que la sesión está iniciada.",
  "settings.connections.test.help.codex":
    "Isomux inició Codex con este inicio de sesión, y Codex indicó que la sesión está iniciada.",
  "settings.connections.test.tools.one": "{count} herramienta",
  "settings.connections.test.tools.other": "{count} herramientas",
  "settings.connections.test.refused":
    "{host} rechazó la credencial. Revísala o rótala.",
  "settings.connections.test.forbidden":
    "{host} acepta la credencial, pero no puede leer la cuenta.",
  "settings.connections.test.noCredential":
    "{host} pide una credencial. Añade una al servidor MCP.",
  "settings.connections.test.status": "{host} respondió {status}.",
  "settings.connections.test.redirect":
    "{host} respondió con una redirección. La prueba no la sigue.",
  "settings.connections.test.timeout": "{host} no respondió a tiempo.",
  "settings.connections.test.unreachable": "No se pudo conectar con {host}.",
  "settings.connections.test.unexpected":
    "{host} dio una respuesta que la prueba no puede leer.",
  "settings.connections.test.needsOauth":
    "{host} pide iniciar sesión con OAuth, que Isomux aún no admite.",
  "settings.connections.test.requestFailed": "No se pudo hacer la prueba.",
  "common.integrations": "Integraciones",
  "integrations.ownerIntro":
    "Configura lo que pueden usar los agentes, para la oficina y para cada miembro.",
  "integrations.memberIntro":
    "Los propietarios configuran lo que usan los agentes. Puedes añadir lo tuyo para los agentes que inicias.",
  "integrations.tabs.providers": "Proveedores de modelos",
  "integrations.tabs.mcp": "Servidores MCP",
  "integrations.tabs.secrets": "Secretos",
  "integrations.tabs.variables": "Variables",
  "integrations.tabs.browser": "Uso del navegador",
  "integrations.tabs.voice": "Voz",
  "integrations.tabs.github": "Incidencias de GitHub",
  "integrations.tabIntro.providers":
    "Las cuentas y claves con las que funcionan los agentes de Claude, Codex y OpenCode.",
  "integrations.tabIntro.mcp":
    "Herramientas que los agentes pueden llamar, como Linear o Sentry.",
  "integrations.tabIntro.secrets":
    "Claves de API y tokens de servicios como GitHub.",
  "integrations.tabIntro.variables":
    "Ajustes simples que los agentes pueden leer, como una zona horaria.",
  "integrations.tabIntro.voice":
    "Lo que usan el micrófono y la lectura en voz alta, en todos tus dispositivos.",
  "integrations.tabIntro.github":
    "Las incidencias abiertas con todas las etiquetas de abajo se convierten en tareas de la sala. Cerrar o reabrir una incidencia en GitHub actualiza su tarea. Isomux no escribe nada en GitHub.",
  "integrations.github.room": "Sala",
  "integrations.github.empty":
    "Crea una sala primero. El vestíbulo no puede enlazar un repositorio.",
  "integrations.github.repo": "Repositorio",
  "integrations.github.labels": "Etiquetas",
  "integrations.github.labelsHint":
    "Sepáralas con comas. Usa etiquetas que no añada ninguna plantilla de incidencias ni ningún flujo de trabajo, para que solo los mantenedores puedan traer una incidencia.",
  "integrations.github.collaboratorsOnly":
    "Solo incidencias de propietarios, miembros y colaboradores del repositorio",
  "integrations.github.secret": "Secreto con el token de GitHub",
  "integrations.github.secretHint":
    "Solo se muestran los secretos de la oficina permitidos para api.github.com. El token debe poder leer las incidencias de este repositorio.",
  "integrations.github.pickSecret": "Elige un secreto",
  "integrations.github.noSecret":
    "Ningún secreto de la oficina está permitido para api.github.com. Añade uno en la pestaña <link>Secretos</link>.",
  "integrations.github.status.pending": "Aún no se ha comprobado.",
  "integrations.github.status.ok": "Al día.",
  "integrations.github.status.missing":
    "En pausa: ningún secreto de la oficina tiene este nombre. Añádelo en la pestaña <link>Secretos</link>.",
  "integrations.github.status.host":
    "En pausa: el secreto no está permitido para api.github.com.",
  "integrations.github.status.refused":
    "En pausa: GitHub rechazó el token. Actualiza el secreto para volver a intentarlo.",
  "integrations.github.status.noAccess":
    "En pausa: el token no puede leer las incidencias de este repositorio. Actualiza el secreto o guarda el enlace para volver a intentarlo.",
  "integrations.github.status.waiting":
    "Esperando a que se restablezca el límite de uso de GitHub.",
  "integrations.github.status.error":
    "No se pudo contactar con GitHub. Se volverá a intentar en unos minutos.",
  "integrations.github.link": "Enlazar repositorio",
  "integrations.github.update": "Actualizar enlace",
  "integrations.github.unlink": "Desenlazar",
  "integrations.voice.mic": "Micrófono",
  "integrations.voice.readAloud": "Lectura en voz alta",
  "integrations.voice.voiceName": "Voz",
  "integrations.voice.browser": "Navegador",
  "integrations.voice.openai": "OpenAI",
  "integrations.voice.where":
    "Con OpenAI, el servidor de la oficina envía a OpenAI tus grabaciones y las respuestas que lees en voz alta.",
  "integrations.voice.key.member": "OpenAI usa {name} de tus variables.",
  "integrations.voice.key.office":
    "OpenAI usa {name} de las variables de la oficina.",
  "integrations.voice.key.server":
    "OpenAI usa {name} del entorno del servidor.",
  "integrations.voice.key.secret":
    "{name} está guardada como secreto. OpenAI la necesita como variable.",
  "integrations.voice.key.none": "Añade OPENAI_VOICE_API_KEY para usar OpenAI.",
  "integrations.voice.saveFailed": "El cambio no se guardó.",
  "integrations.secretsHonesty":
    "Isomux impide que los agentes lean los secretos guardados, pero esta oficina no tiene un muro firme entre los agentes y sus archivos o apps.",
  "integrations.secrets.modelKeys":
    "Las claves de API de modelos, como <code>ANTHROPIC_API_KEY</code>, van en <link>Variables</link>, no aquí: Isomux nunca envía un secreto a un proveedor de modelos.",
  "integrations.office": "De toda la oficina",
  "integrations.officeWho": "Todos los agentes de la oficina",
  "integrations.officeWhoMember":
    "Todos los agentes de la oficina. Solo los propietarios pueden cambiar estas integraciones.",
  "integrations.personal": "Personales",
  "integrations.personalWhoSelf":
    "Los agentes que inicias. Una de aquí sustituye a la de toda la oficina con el mismo nombre.",
  "integrations.personalWhoMember":
    "Los agentes que inicia {member}. Una de aquí sustituye a la de toda la oficina con el mismo nombre.",
  "integrations.memberTitle": "Integraciones de {member}",
  "integrations.backToYours": "Volver a las tuyas",
  "integrations.picker": "De quién son las integraciones",
  "integrations.applies":
    "Los agentes de Claude y Codex reciben un cambio cuando inician una conversación nueva. Los agentes de OpenCode reciben los cambios de servidores MCP en su siguiente mensaje, los de claves de API cuando ninguno de ellos esté trabajando, y los demás cuando inician una conversación nueva.",
  "integrations.helpTip": "¿Qué significa esto?",
  "integrations.show": "Mostrar",
  "integrations.hide": "Ocultar",
  "integrations.remove": "Quitar",
  "integrations.moreOptions": "Más opciones",
  "integrations.actionFailed": "No se pudo hacer. Vuelve a intentarlo.",
  "integrations.dialog.edit.self": "Editar {name}",
  "integrations.dialog.edit.member": "Editar {name} de {member}",
  "integrations.dialog.edit.office": "Editar {name} de toda la oficina",
  "integrations.dialog.remove.self": "¿Quitar {name}?",
  "integrations.dialog.remove.member": "¿Quitar {name} de {member}?",
  "integrations.dialog.remove.office": "¿Quitar {name} de toda la oficina?",
  "integrations.providers.apiKeys":
    "¿Prefieres una clave de API? Añade <code>ANTHROPIC_API_KEY</code>, <code>OPENAI_API_KEY</code> u <code>OPENCODE_API_KEY</code> en <link>Variables</link>.",
  "integrations.providers.memberSignsIn":
    "Los miembros inician sesión en sus propias cuentas.",
  "integrations.status.connected": "Conectado",
  "integrations.status.pending": "Pendiente",
  "integrations.status.needsAuth": "Requiere inicio de sesión",
  "integrations.status.failed": "Error",
  "integrations.status.off": "Desactivado",
  "integrations.connectors.title":
    "De claude.ai, para los agentes de Claude en {account}",
  "integrations.connectors.titleNoAccount":
    "De claude.ai, para los agentes de Claude con este inicio de sesión",
  "integrations.connectors.hint":
    "Los agentes de Claude con esta cuenta también los reciben. <link>Gestiónalos en claude.ai</link>.",
  "integrations.connectors.unknown":
    "Isomux los muestra después de que un agente de Claude con esta cuenta haga un turno.",
  "integrations.connectors.pendingHelp":
    "Claude informa de sus conectores cuando empieza un turno, mientras algunos aún se conectan. Isomux vuelve a comprobarlo 10 segundos después.",
  "integrations.engineMcp.title": "Configurados en los archivos de Claude",
  "integrations.engineMcp.source":
    "Lo que informaron tus agentes de Claude, solo en las carpetas donde ha trabajado alguno.",
  "integrations.mcp.empty": "No hay servidores MCP.",
  "integrations.mcp.nameHint":
    "Los agentes ven este nombre, por ejemplo linear.",
  "integrations.mcp.url": "Dirección del servidor (URL)",
  "integrations.mcp.urlHint":
    "La documentación del servicio da esta dirección. Pon un token en Inicio de sesión, no en la dirección.",
  "integrations.mcp.auth": "Inicio de sesión",
  "integrations.mcp.authOauth": "Iniciar sesión en el servidor (OAuth)",
  "integrations.mcp.authToken": "Pegar un token",
  "integrations.mcp.authSaved": "Usar un secreto guardado",
  "integrations.mcp.authNone": "Ninguno",
  "integrations.mcp.token": "Token",
  "integrations.mcp.tokenGoesTo": "Isomux envía el token solo a {host}.",
  "integrations.mcp.tokenNoHost":
    "Escribe primero la dirección: Isomux envía el token solo a su host.",
  "integrations.mcp.tokenName": "Se guarda como",
  "integrations.mcp.tokenNameHint":
    "El token se guarda en la pestaña Secretos con este nombre.",
  "integrations.mcp.savedSecret": "Secreto",
  "integrations.mcp.pickSecret": "Elige un secreto",
  "integrations.mcp.oauthHint":
    "Al guardar, se abre una página de inicio de sesión del servicio. Los agentes de Claude, Codex y OpenCode reciben el acceso.",
  "integrations.mcp.clientHint":
    "Déjalos vacíos salvo que el servidor necesite un cliente que registraste en él.",
  "integrations.mcp.saveAndSignIn": "Guardar e iniciar sesión",
  "integrations.mcp.status.signedIn": "Sesión iniciada",
  "integrations.mcp.status.needsSignIn": "Requiere inicio de sesión",
  "integrations.mcp.status.token": "Token guardado",
  "integrations.mcp.status.none": "Sin inicio de sesión",
  "integrations.mcp.addHeading.self": "Añadir un servidor MCP",
  "integrations.mcp.addHeading.member": "Añadir un servidor MCP para {member}",
  "integrations.mcp.addHeading.office":
    "Añadir un servidor MCP para toda la oficina",
  "integrations.mcp.signedIn": "Sesión iniciada.",
  "integrations.providers.noPersonal": "Sin inicio de sesión personal",
  "integrations.signIn.office":
    "Inicia sesión para cada agente de esta oficina",
  "integrations.signIn.personal": "Inicia sesión para los agentes que creo",
  "integrations.providers.opencode.bundled":
    "Viene con Isomux. Los modelos gratuitos no necesitan cuenta ni clave.",
  "integrations.providers.opencode.keySet":
    "<code>OPENCODE_API_KEY</code> está configurada, para los modelos de pago.",
  "integrations.providers.opencode.noKeyOffice":
    "No hay <code>OPENCODE_API_KEY</code>. Los modelos de pago necesitan una en <link>Variables</link>.",
  "integrations.providers.opencode.noKeyPersonal":
    "No hay <code>OPENCODE_API_KEY</code>. Para añadir una, ve a <link>Variables</link>.",
  "integrations.providers.testSignedOut": "No hay sesión iniciada.",
  "integrations.connectionsFailed":
    "No se pudieron cargar los conectores de claude.ai ni los servidores configurados en los archivos de Claude.",
  "integrations.memberGone": "{member} ya no está en esta oficina.",
  "integrations.secrets.empty": "No hay secretos.",
  "integrations.secrets.add": "Añadir un secreto",
  "integrations.secrets.value": "Clave o token",
  "integrations.secrets.valuePlaceholder": "Pégalo aquí",
  "integrations.secrets.newValuePlaceholder": "Pega el valor nuevo",
  "integrations.secrets.nameHint":
    "Los agentes ven este nombre, por ejemplo MY_API_KEY.",
  "integrations.secrets.addresses": "Direcciones que pueden recibirlo",
  "integrations.secrets.addressesHint":
    "Las direcciones web del servicio, una por línea, como api.example.com. Isomux no envía la clave a ninguna otra dirección. Añade solo direcciones que sean del servicio.",
  "integrations.secrets.presetGoesTo": "Isomux lo envía solo a {service}.",
  "integrations.secrets.showAddresses": "Mostrar las direcciones",
  "integrations.secrets.hideAddresses": "Ocultar las direcciones",
  "integrations.secrets.howSent": "Cómo lo espera el servicio",
  "integrations.secrets.bearer": "Como token bearer (la mayoría de servicios)",
  "integrations.secrets.customHeader": "En una cabecera con otro nombre",
  "integrations.secrets.headerPlaceholder":
    "Nombre de la cabecera, como x-api-key",
  "integrations.secrets.presetSet": "{service} · guardado el {date}",
  "integrations.secrets.goesToSet": "Va a {hosts} · guardado el {date}",
  "integrations.secrets.goesTo": "Va a {hosts}",
  "integrations.secrets.apps": "Apps que pueden leerlo",
  "integrations.secrets.appsHint":
    "La app recibe el valor en su entorno y se reinicia cuando el secreto cambia.",
  "integrations.secrets.noApps": "No hay apps.",
  "integrations.secrets.readBy": "Leído por {apps}",
  "integrations.secrets.readBySet": "Leído por {apps} · guardado el {date}",
  "integrations.secrets.reachesNothing":
    "No va a ningún sitio. Añade una dirección o una app.",
  "integrations.secrets.saveNeedsTarget":
    "Para guardar, añade una dirección o una app.",
  "integrations.secrets.modelKeyWarning":
    "Los agentes no pueden iniciar sesión con este secreto. Muévelo a Variables.",
  "integrations.secrets.showFailed": "No se pudo mostrar el valor.",
  "integrations.secrets.reissueHint":
    "Los agentes reciben un sustituto nuevo y el anterior deja de funcionar.",
  "integrations.secrets.addHeading.self": "Añadir un secreto",
  "integrations.secrets.addHeading.member": "Añadir un secreto para {member}",
  "integrations.secrets.addHeading.office":
    "Añadir un secreto para toda la oficina",
  "integrations.secrets.replaceHeading.self": "Reemplazar el valor de {name}",
  "integrations.secrets.replaceHeading.member":
    "Reemplazar el valor de {name} de {member}",
  "integrations.secrets.replaceHeading.office":
    "Reemplazar el valor de {name} de toda la oficina",
  "integrations.secrets.reissueHeading.self": "Nuevo sustituto para {name}",
  "integrations.secrets.reissueHeading.member":
    "Nuevo sustituto para {name} de {member}",
  "integrations.secrets.reissueHeading.office":
    "Nuevo sustituto para {name} de toda la oficina",
  "integrations.variables.empty": "No hay variables.",
  "integrations.variables.modelKeys":
    "Las claves de API de modelos, como <code>ANTHROPIC_API_KEY</code>, van aquí, no en Secretos: Isomux nunca envía un secreto a un proveedor de modelos.",
  "integrations.variables.looksLikeKey":
    "Los agentes pueden leer el valor de una variable. Si ningún agente necesita el valor real, guárdalo como secreto.",
  "integrations.variables.exists": "Ya existe una variable con este nombre.",
  "integrations.variables.addHeading.self": "Añadir una variable",
  "integrations.variables.addHeading.member":
    "Añadir una variable para {member}",
  "integrations.variables.addHeading.office":
    "Añadir una variable para toda la oficina",
  "integrations.variables.replaceHeading.self": "Reemplazar el valor de {name}",
  "integrations.variables.replaceHeading.member":
    "Reemplazar el valor de {name} de {member}",
  "integrations.variables.replaceHeading.office":
    "Reemplazar el valor de {name} de toda la oficina",

  "settings.signIn.apiKeyNote":
    "¿Quieres usar un token de API? Mira Integraciones → Variables.",
  "settings.signIn.scopeOffice":
    "Toda la oficina: inicia sesión para cada agente de esta oficina",
  "settings.signIn.scopePersonal":
    "Personal: inicia sesión para los agentes que creo",
  "settings.signIn.officeHint":
    "Esta suscripción se usa para cada agente de la oficina salvo los que crea un miembro con su propio <link>inicio de sesión personal</link>.",
  "settings.signIn.personalHint": "Usa una cuenta aparte para tus agentes.",
  "settings.signIn.askOfficeOwner":
    "Pide a un propietario de la oficina que inicie sesión.",
  "settings.signIn.status": "Estado:",
  "settings.signIn.checking": "Comprobando la conexión…",
  "settings.signIn.waiting": "Esperando al proveedor…",
  "settings.signIn.connectedAs": "Conectado como {account}",
  "settings.signIn.connected": "Conectado",
  "settings.signIn.unavailable": "Conexión no disponible",
  "settings.signIn.notConnected": "Sin conectar",
  "settings.signIn.apiKey": "Se usa una clave de API",
  "settings.signIn.codexKey.server":
    "Tus agentes usan <code>OPENAI_API_KEY</code> del entorno del servidor en lugar de un inicio de sesión.",
  "settings.signIn.codexKey.officeVariable":
    "Tus agentes usan la variable <code>OPENAI_API_KEY</code> de toda la oficina en lugar de un inicio de sesión.",
  "settings.signIn.codexKey.officeSecret":
    "Tus agentes usan el secreto <code>OPENAI_API_KEY</code> de toda la oficina en lugar de un inicio de sesión.",
  "settings.signIn.codexKey.memberVariable":
    "Tus agentes usan tu variable personal <code>OPENAI_API_KEY</code> en lugar de un inicio de sesión.",
  "settings.signIn.codexKey.memberSecret":
    "Tus agentes usan tu secreto personal <code>OPENAI_API_KEY</code> en lugar de un inicio de sesión.",
  "settings.signIn.startFailed":
    "No se ha podido iniciar sesión en {provider}.",
  "settings.signIn.submitFailed": "No se ha podido enviar el código de Claude.",
  "settings.signIn.cancelFailed":
    "No se ha podido cancelar el inicio de sesión.",
  "settings.signIn.queueHeldUnderMinute":
    "{name} está iniciando sesión en esta cuenta compartida de {provider}; empezó hace menos de un minuto.",
  "settings.signIn.queueHeldMinutes.one":
    "{name} está iniciando sesión en esta cuenta compartida de {provider}; empezó hace {count} minuto.",
  "settings.signIn.queueHeldMinutes.other":
    "{name} está iniciando sesión en esta cuenta compartida de {provider}; empezó hace {count} minutos.",
  "settings.signIn.cancelShared": "Cancelar este inicio de sesión",
  "settings.signIn.signOutFailed":
    "No se ha podido cerrar la sesión de {provider}.",
  "settings.signIn.externalWarning":
    "Esto cierra la sesión de {provider} en esta máquina, incluso fuera de la oficina.",
  "settings.signIn.directoryWarning":
    "Esto quita la sesión del directorio de cuentas que elegiste.",
  "settings.signIn.pasteCode": "Pega el código de Claude:",
  "settings.signIn.submitCode": "Enviar el código",
  "settings.signIn.cancelSignIn": "Cancelar el inicio de sesión",
  "settings.signIn.signingIn": "Iniciando sesión…",
  "settings.signIn.signIn": "Iniciar sesión",
  "settings.signIn.codexHint":
    "Al iniciar sesión te damos un código de un solo uso para escribirlo en la página de OpenAI. La página se abre en una pestaña nueva; también la puedes abrir en cualquier otro dispositivo.",
  "settings.signIn.claudeHint":
    "Claude se abre en tu navegador. Cuando hayas iniciado sesión, pega el código aquí.",
  "settings.signIn.linkNotOpen": "¿No se ha abierto el enlace?",
  "settings.signIn.linkCopied": "Enlace copiado",
  "settings.signIn.copyLink": "Copiar el enlace de inicio de sesión",
  "settings.signIn.enterCode":
    "Escribe este código de un solo uso en la página de OpenAI:",
  "settings.signIn.signOutDialog": "Cerrar la sesión de {provider}",
  "settings.signIn.signingOut": "Cerrando la sesión…",
  "settings.signIn.confirmSignOut": "Confirmar el cierre de sesión",
  "settings.signIn.connectedStart":
    "Conectado. Empieza una conversación nueva para usar esta cuenta.",
  "settings.signIn.startConversation": "Empezar una conversación nueva",

  "settings.env.loadFailed": "No se han podido cargar las variables",
  "settings.env.saveFailed": "No se han podido guardar las variables",
  "settings.env.loadingVariables": "Cargando las variables…",
  "settings.env.variableName": "Nombre de la variable",
  "settings.env.valueLabel": "Valor de {name}",
  "settings.env.variable": "Variable",
  "settings.env.valuePlaceholder": "Valor",
  "settings.env.remove": "Quitar",
  "settings.env.add": "Añadir una variable",

  "settings.memberConnections.loadFailed":
    "No se han podido cargar las conexiones.",
  "settings.memberConnections.unknown": "No se pudo comprobar el estado.",
  "settings.memberApiTokens.title": "Tokens de API",
  "settings.memberApiTokens.hint":
    "Revoca un token para detenerlo en su próxima solicitud.",
  "dialogs.textarea.expand": "Ampliar {title}",
  "dialogs.textarea.escCollapse": "Esc para plegar",
  "dialogs.textarea.done": "Hecho",

  "dialogs.schedulePrompt.title": "Instrucciones de las programaciones",
  "dialogs.schedulePrompt.rulesHint":
    "(se añade al prompt de sistema de cada ejecución programada)",
  "dialogs.schedulePrompt.rulesPlaceholder":
    "p. ej. Escribe siempre los hallazgos en un archivo markdown. Sé conciso.",
  "dialogs.schedulePrompt.appliedNextRun":
    "Se aplica a la próxima ejecución; las que están en curso usan la copia que capturaron.",
  "dialogs.schedulePrompt.loadFailed":
    "No se pudieron cargar las instrucciones de las programaciones.",
  "common.field.engine": "Motor",
  "common.field.model": "Modelo",
  "common.field.effort": "Esfuerzo de razonamiento",
  "common.field.sandbox": "Sandbox",
  "common.field.permissionMode": "Modo de permisos",
  "common.field.approvalPolicy": "Política de aprobación",
  "common.field.workingDirectory": "Directorio de trabajo",

  "common.effort.minimal": "Mínimo",
  "common.effort.low": "Bajo",
  "common.effort.medium": "Medio",
  "common.effort.high": "Alto",
  "common.effort.xhigh": "Muy alto",
  "common.effort.max": "Máximo",
  "common.effort.ultra": "Ultra (solo Codex)",

  "common.permission.claudeBypass":
    "Omitir permisos (se aprueba todo automáticamente)",
  "common.permission.codexNever": "No preguntar nunca (solo el sandbox)",
  "common.sandbox.readOnly":
    "Solo lectura (el modelo puede leer, nunca escribir)",
  "common.sandbox.workspaceWrite":
    "Escritura en el espacio de trabajo (solo dentro del cwd)",
  "common.sandbox.dangerFullAccess": "Peligro: acceso total (sin sandbox)",

  "common.model.currentOption": "Modelo actual",
  "common.model.currentIs": "Modelo actual: {model}.",
  "common.model.checkFailed":
    "No se han podido comprobar los modelos disponibles. Vuelve a abrir este diálogo para intentarlo de nuevo.",
  "common.model.notOffered":
    "Esta cuenta no lo ofrece. Elige un modelo disponible.",
  "common.model.loading": "Cargando los modelos disponibles…",
  "common.model.startingOpenCode":
    "OpenCode se está iniciando. Cargando los modelos disponibles…",
  "common.model.noneConnected":
    "OpenCode no tiene modelos de ningún proveedor conectado para este entorno.",
  "common.model.selectConnected":
    "Elige un modelo de OpenCode conectado antes de guardar.",
  "common.model.loadFailed": "No se pudieron cargar los modelos",
  "common.model.openCodeListFailed":
    "OpenCode no ha podido listar sus modelos. Vuelve a abrir este diálogo.",
  "common.model.codexNotSignedIn":
    "No has iniciado sesión en Codex. Abre un agente de Codex y pulsa la tarjeta de inicio de sesión que emite, y luego vuelve a abrir este diálogo. (O define OPENAI_API_KEY en tu entorno.)",
  "common.model.openCodeLoadFailed":
    "No se pudieron cargar los modelos de OpenCode{detail}. Vuelve a abrir este diálogo para intentarlo de nuevo.",
  "common.model.listLoadFailed":
    "No se pudo cargar la lista de modelos{detail}. Se muestra la lista de reserva - puede que algunas opciones no funcionen en tu cuenta.",

  "dialogs.schedule.titleNew": "Programación nueva",
  "dialogs.schedule.titleEdit": "Editar la programación",
  "dialogs.schedule.namePlaceholder": "Resumen diario",
  "dialogs.schedule.daily": "Cada día",
  "dialogs.schedule.weekly": "Cada semana",
  "dialogs.schedule.interval": "Cada N minutos",
  "dialogs.schedule.none": "Bajo demanda",
  "dialogs.schedule.weekday.sunday": "Domingo",
  "dialogs.schedule.weekday.monday": "Lunes",
  "dialogs.schedule.weekday.tuesday": "Martes",
  "dialogs.schedule.weekday.wednesday": "Miércoles",
  "dialogs.schedule.weekday.thursday": "Jueves",
  "dialogs.schedule.weekday.friday": "Viernes",
  "dialogs.schedule.weekday.saturday": "Sábado",
  "dialogs.schedule.hour": "Hora (0-23)",
  "dialogs.schedule.minute": "Minuto (0-59)",
  "dialogs.schedule.intervalMinutes": "Intervalo (minutos, mínimo 5)",
  "dialogs.schedule.serverLocal": "Las horas son las del servidor.",
  "dialogs.schedule.prompt": "Prompt",
  "dialogs.schedule.promptTitle": "Prompt de la programación",
  "dialogs.schedule.promptPlaceholder":
    'p. ej. "Resume lo que consiguió ayer cada agente."',
  "dialogs.schedule.promptEmpty": "El prompt no puede estar vacío.",
  "dialogs.schedule.permissionUnattended":
    "Permitir las herramientas del proyecto (sin supervisión)",
  "dialogs.schedule.permissionHintOpenCode":
    "Se permiten las herramientas de shell y de edición. Se deniegan la delegación y las preguntas.",
  "dialogs.schedule.permissionHint":
    "Las programaciones se ejecutan sin supervisión - los modos que piden aprobación humana no están disponibles.",
  "dialogs.schedule.enabled":
    "Activada (desmárcala para pausarla sin eliminarla)",
  "dialogs.schedule.create": "Crear",

  "dialogs.agent.titleSpawn": "Crear un agente nuevo",
  "dialogs.agent.titleEdit": "Editar el agente",
  "dialogs.agent.desk": "Escritorio #{desk}",
  "dialogs.agent.backRoom": "Trastienda",
  "dialogs.agent.moveToBackOf": "Trastienda de {room}",
  "dialogs.agent.engineBlurb.claude": "Funciona con tu cuenta de Claude Code.",
  "dialogs.agent.engineBlurb.codex": "Funciona con tu cuenta de ChatGPT.",
  "dialogs.agent.engineBlurb.opencode":
    "Funciona con los modelos configurados a través de OpenCode.",
  "dialogs.agent.engineNeedsLinux": "Necesita un servidor Linux.",
  "dialogs.agent.engineSwitchHint":
    "Cambiar a {engine} empieza una conversación nueva. La actual se queda en el historial de sesiones de este agente.",
  "dialogs.agent.templateHint":
    "Las plantillas rellenan los campos de abajo. Puedes editar todas las sugerencias.",
  "dialogs.agent.blank": "En blanco",
  "dialogs.agent.blankHint": "Configura el agente tú mismo.",
  "dialogs.agent.appearance": "Aspecto",
  "dialogs.agent.randomize": "Elegir al azar",
  "dialogs.agent.skin": "Piel",
  "dialogs.agent.shirt": "Camiseta",
  "dialogs.agent.hairColor": "Color del pelo",
  "dialogs.agent.hairStyle": "Peinado",
  "dialogs.agent.costume": "Disfraz",
  "dialogs.agent.costume.none": "Ninguno",
  "dialogs.agent.costume.doctor": "Médico",
  "dialogs.agent.costume.police": "Policía",
  "dialogs.agent.costume.firefighter": "Bombero",
  "dialogs.agent.costume.chef": "Chef",
  "dialogs.agent.costume.construction": "Trabajador de la construcción",
  "dialogs.agent.costume.astronaut": "Astronauta",
  "dialogs.agent.hat": "Gorro",
  "dialogs.agent.beard": "Barba",
  "dialogs.agent.accessory": "Accesorio",
  "dialogs.agent.hairStyle.short": "Corto",
  "dialogs.agent.hairStyle.long": "Largo",
  "dialogs.agent.hairStyle.ponytail": "Coleta",
  "dialogs.agent.hairStyle.bun": "Moño",
  "dialogs.agent.hairStyle.pigtails": "Coletas",
  "dialogs.agent.hairStyle.curly": "Rizado",
  "dialogs.agent.hairStyle.bald": "Calvo",
  "dialogs.agent.hat.none": "Ninguno",
  "dialogs.agent.hat.cap": "Gorra",
  "dialogs.agent.hat.beanie": "Gorro de lana",
  "dialogs.agent.hat.bow": "Lazo",
  "dialogs.agent.hat.headband": "Cinta",
  "dialogs.agent.accessory.none": "Ninguno",
  "dialogs.agent.accessory.glasses": "Gafas",
  "dialogs.agent.accessory.headphones": "Auriculares",
  "dialogs.agent.accessory.bowTie": "Pajarita",
  "dialogs.agent.accessory.tie": "Corbata",
  "dialogs.agent.accessory.earrings": "Pendientes",
  "dialogs.agent.beard.none": "Ninguna",
  "dialogs.agent.beard.stubble": "Incipiente",
  "dialogs.agent.beard.full": "Poblada",
  "dialogs.agent.beard.goatee": "Perilla",
  "dialogs.agent.beard.mustache": "Bigote",
  "dialogs.agent.recent": "Recientes",
  "dialogs.agent.manager": "Responsable",
  "dialogs.agent.managerTitle":
    "Solo un propietario de la oficina puede cambiar el responsable.",
  "dialogs.agent.managerRestart": "Al guardar empieza una conversación nueva.",
  "dialogs.agent.managerNoRoomAccess": "{name} no tiene acceso a esta sala.",
  "dialogs.agent.managerNoUser": "(sin miembro asignado)",
  "dialogs.agent.managerUnowned": "(sin propietario)",
  "dialogs.agent.managerHint":
    "El agente usa las conexiones a proveedores y las variables personales de este miembro. Consulta la página Integraciones.",
  "dialogs.agent.privileged": "Acceso de operador con privilegios",
  "dialogs.agent.privilegedHint":
    "Permite a este agente actuar por ti en toda la oficina: crear y eliminar agentes y dirigir sus conversaciones, gestionar salas, programaciones e integraciones, y publicar en el chat de miembros. Si eres propietario de la oficina, también puede añadir miembros y cambiar la configuración de la oficina. Actúa como sí mismo, con tu acceso.",
  "dialogs.agent.privilegedRestart":
    "Al guardar se reinicia la sesión del agente.",
  "dialogs.agent.autoHandoff": "Traspaso automático",
  "dialogs.agent.autoHandoffHint":
    "Cuando el contexto se llena, el agente escribe un resumen y continúa en una sesión nueva. El chat se vacía.",
  "dialogs.agent.autoHandoffTokens": "Traspasar al llegar a {input}k tokens",
  "dialogs.agent.autoHandoffTokensError":
    "Introduce un número de {min} a {max}.",
  "dialogs.agent.limitResume": "Reanudar tras el límite de uso",
  "dialogs.agent.limitResumeHint":
    "Cuando un límite de uso detiene al agente, continúa cuando el límite se restablece.",
  "dialogs.agent.permission.ask": "Preguntar",
  "dialogs.agent.permission.bypassAll": "Omitir todos los permisos",
  "dialogs.agent.permission.codexUntrusted":
    "No fiable (preguntar en cada herramienta)",
  "dialogs.agent.permission.codexOnRequest":
    "A petición (el modelo pregunta cuando lo necesita)",
  "dialogs.agent.permission.claudeAuto":
    "Auto (un clasificador aprueba las acciones seguras)",
  "dialogs.agent.permission.claudeDefault": "Por defecto (preguntar para todo)",
  "dialogs.agent.permission.claudeAcceptEdits":
    "Aceptar ediciones (aprobar los cambios en archivos)",
  "dialogs.agent.modelTier.free":
    "Gratis (el proveedor puede usar el tráfico para entrenar)",
  "dialogs.agent.modelTier.payg": "Pago por uso (créditos de OpenCode)",
  "dialogs.agent.modelTier.subscription": "Suscripción (OpenCode Go)",
  "dialogs.agent.memoryHint":
    "(hechos duraderos de este agente; líneas en bruto; {size} / {cap})",
  "dialogs.agent.memoryTitle": "Memoria del agente",
  "dialogs.agent.memoryPlaceholder":
    "Alguna memoria relevante para este agente",
  "dialogs.agent.customInstructions": "Instrucciones personalizadas",
  "dialogs.agent.group.template": "Plantilla",
  "dialogs.agent.group.identity": "Identidad",
  "common.instructionsAndMemory": "Instrucciones y memoria",
  "dialogs.agent.spawnPreviewHint":
    "El ID del agente se asignará al crearlo. Esta vista previa usa «new-agent».",
  "dialogs.agent.cwdHint":
    "La carpeta donde el agente empieza a trabajar. El agente también puede acceder a archivos fuera de esta carpeta.",
  "dialogs.agent.memoryStartsEmpty": "La memoria empieza vacía.",
  "dialogs.agent.group.engine": "Modelo y comportamiento",
  "dialogs.agent.group.workspace": "Espacio de trabajo",
  "dialogs.agent.group.instructions": "Instrucciones",
  "dialogs.agent.group.access": "Acceso y ubicación",
  "dialogs.agent.group.restore": "Restaurar",
  "dialogs.agent.optional": "(opcional)",
  "dialogs.agent.customInstructionsHint":
    "Prompt de sistema personal para este agente.",
  "dialogs.agent.showSystemPrompt": "Mostrar el prompt de sistema completo",
  "dialogs.agent.systemPromptTitle": "Prompt de sistema completo",
  "dialogs.agent.systemPromptLoadFailed":
    "No se pudo cargar el prompt de sistema.",
  "dialogs.agent.cronjobPromptTitle": "Prompt de la programación",
  "dialogs.agent.showCronjobPrompt": "Mostrar prompt de la programación",
  "dialogs.agent.helpTitle": "Ayuda",
  "dialogs.agent.showHelp": "Mostrar ayuda",
  "dialogs.agent.customInstructionsPlaceholder":
    'p. ej. "Eres un especialista en backend. Escribe siempre tests."',
  "dialogs.agent.revive": "Reactivar un agente detenido",
  "dialogs.agent.reviving": "Reactivando…",
  "dialogs.agent.reviveFailed": "No se pudo reactivar",
  "dialogs.agent.moveToRoom": "Mover a la sala",
  "dialogs.agent.invalidDirectory": "Directorio no válido",
  "dialogs.agent.staleInstructions":
    "Las instrucciones personalizadas han cambiado desde que abriste esto - vuelve a abrir el diálogo para editar la versión más reciente.",
  "dialogs.agent.spawn": "Crear",

  "templates.moneyPlanner.label": "Planificador de finanzas",
  "templates.moneyPlanner.description":
    "Planifica gastos, ahorro, objetivos y decisiones financieras.",
  "templates.sideProjectBuilder.label": "Creador de proyectos paralelos",
  "templates.sideProjectBuilder.description":
    "Convierte una idea vaga en un producto pequeño que llega a publicarse.",
  "templates.healthNavigator.label": "Guía de salud",
  "templates.healthNavigator.description":
    "Organiza la información de salud y prepara las consultas.",
  "templates.lifeCoach.label": "Coach de vida",
  "templates.lifeCoach.description":
    "Aclara objetivos, elige los siguientes pasos y revisa el progreso.",
  "templates.researchAnalyst.label": "Analista de investigación",
  "templates.researchAnalyst.description":
    "Investiga preguntas y produce informes listos para decidir.",
  "templates.personalSiteBuilder.label": "Creador de sitios personales",
  "templates.personalSiteBuilder.description":
    "Diseña, construye y publica un sitio web personal.",
  "templates.cityGuide.label": "Guía de la ciudad",
  "templates.cityGuide.description":
    "Descubre lugares y planifica según cómo exploras.",
  "templates.todoListAssistant.label": "Asistente de tareas pendientes",
  "templates.todoListAssistant.description":
    "Convierte los compromisos en un sistema personal que sigue siendo útil.",
  "templates.codeReviewer.label": "Revisor de código",
  "templates.codeReviewer.description":
    "Encuentra los defectos que importan y explica soluciones precisas.",
  "templates.relationshipAdvisor.label": "Consejero de relaciones",
  "templates.relationshipAdvisor.description":
    "Piensa a fondo la comunicación, las necesidades y los siguientes pasos.",
  "templates.jobSearchCoach.label": "Coach de búsqueda de empleo",
  "templates.jobSearchCoach.description":
    "Enfoca la búsqueda y mejora las candidaturas y las entrevistas.",
  "templates.tripPlanner.label": "Planificador de viajes",
  "templates.tripPlanner.description":
    "Construye viajes prácticos según tus intereses y tus límites.",
  // The API-call card (S5): what an agent's curl against the isomux API
  // did, in one line. A route's static label and the parameter-aware
  // sentence for the same call share a key when their English matches.
  "apiCall.membersChat.read": "Leer el chat de miembros",
  "apiCall.membersChat.post": "Publicar en el chat de miembros",
  "apiCall.membersChat.edit": "Editar un mensaje del chat de miembros",
  "apiCall.membersChat.delete": "Eliminar un mensaje del chat de miembros",
  "apiCall.membersChat.markRead": "Marcar el chat de miembros como leído",
  "apiCall.tasks.list": "Listar tareas",
  "apiCall.tasks.create": "Crear tarea",
  "apiCall.tasks.claim": "Reclamar tarea",
  "apiCall.tasks.complete": "Completar tarea",
  "apiCall.tasks.update": "Actualizar tarea",
  "apiCall.tasks.delete": "Eliminar tarea",
  "apiCall.pager.list": "Listar avisos",
  "apiCall.pager.get": "Leer aviso",
  "apiCall.pager.raise": "Enviar aviso",
  "apiCall.pager.ack": "Confirmar aviso",
  "apiCall.pager.resolve": "Resolver aviso",
  "apiCall.asks.create": "Crear petición",
  "apiCall.asks.list": "Listar peticiones",
  "apiCall.asks.get": "Consultar petición",
  "apiCall.asks.edit": "Editar petición",
  "apiCall.asks.delete": "Eliminar petición",
  "asks.title": "Peticiones",
  "asks.reply": "Responder",
  "asks.dismiss": "Descartar",
  "asks.replyDefault": "hecho",
  "asks.recommended": "Recomendada",
  "asks.link": "Petición",
  "asks.openLink": "Abrir {page}",
  "asks.discuss": "Comentar en el chat",
  "asks.aboutPrefix": 'Sobre tu petición "{question}": ',
  "asks.dismissed": "Descartada",
  "asks.dismissedReason": "Descartada: {reason}",
  "asks.fileTask": "Ahora no; convertir en tarea",
  "asks.filedAsTask": "Convertida en tarea {task}",
  "asks.filedAsTaskNote": "Convertida en tarea {task}: {note}",
  "asks.badge.one": "{count} petición",
  "asks.badge.other": "{count} peticiones",
  "asks.answerFailed": "No enviado: {error}",
  "asks.empty": "No hay peticiones abiertas.",
  "apiCall.tasks.listOpen": "Listar tareas abiertas",
  "apiCall.tasks.listOpenGlobal":
    "Listar tareas abiertas (solo las globales de la oficina)",
  "apiCall.tasks.listOpenInRoom": "Listar tareas abiertas de una sala",
  "apiCall.tasks.listAll": "Listar todas las tareas",
  "apiCall.tasks.listAllGlobal":
    "Listar todas las tareas (solo las globales de la oficina)",
  "apiCall.tasks.listAllInRoom": "Listar todas las tareas de una sala",
  "apiCall.tasks.listStatus": "Listar tareas con estado {status}",
  "apiCall.tasks.listStatusGlobal":
    "Listar tareas con estado {status} (solo las globales de la oficina)",
  "apiCall.tasks.listStatusInRoom":
    "Listar tareas con estado {status} de una sala",
  "apiCall.tasks.createTitled": "Crear tarea: {title}",
  "apiCall.tasks.createPlain": "Crear una tarea",
  "apiCall.tasks.updateOne": "Actualizar la tarea {task}",
  "apiCall.tasks.deleteOne": "Eliminar la tarea {task}",
  "apiCall.tasks.readOne": "Leer la tarea {task}",
  "apiCall.tasks.claimFor": "Reclamar la tarea {task} para {assignee}",
  "apiCall.tasks.claimOne": "Reclamar la tarea {task}",
  "apiCall.tasks.markDone": "Marcar la tarea {task} como hecha",
  "apiCall.agents.list": "Listar los agentes de la oficina",
  "apiCall.agents.listKilled": "Listar los agentes eliminados",
  "apiCall.agents.listWithBackRooms":
    "Listar los agentes de la oficina, trastiendas incluidas",
  "apiCall.agents.listInvalidBack":
    "Listar agentes (filtro de trastienda no válido)",
  "apiCall.agents.listInvalidFilter":
    "Listar agentes (filtro de eliminados no válido)",
  "apiCall.agents.sendMessage": "Enviar un mensaje a un agente",
  "apiCall.agents.sendMessageTo": "Enviar un mensaje a {who}",
  "apiCall.agents.steerMessage": "Enviar un mensaje a {who} a mitad de turno",
  "apiCall.agents.scheduleMessage": "Programar un mensaje para {who}",
  "apiCall.agents.spawn": "Crear un agente nuevo",
  "apiCall.agents.spawnNamed": "Crear el agente {name}",
  "apiCall.agents.editSettings": "Editar los ajustes de {who}",
  "apiCall.agents.remove": "Eliminar el agente {who}",
  "apiCall.agents.handoff": "Traspasar a una sesión nueva",
  "apiCall.agents.handoffFor": "Traspasar a {who} a una sesión nueva",
  "apiCall.agents.scheduledList": "Listar los mensajes programados",
  "apiCall.agents.scheduledListFor":
    "Listar los mensajes programados que {who} tiene por enviar",
  "apiCall.agents.scheduledCancel": "Cancelar un mensaje programado",
  "apiCall.agents.scheduledCancelFor":
    "Cancelar uno de los mensajes programados de {who}",
  "apiCall.agents.shareFile": "Compartir un archivo en el chat",
  "apiCall.agents.shareFileDetail": "Compartir un archivo en el chat",
  "apiCall.agents.previewUrl": "Capturar una página en el chat",
  "apiCall.agents.previewUrlDetail": "Capturar una página en el chat",
  "apiCall.browser.unpairOne": "Desvincular un navegador",
  "apiCall.agents.browser": "Usar el navegador",
  "apiCall.agents.browserDetail": "Usar el navegador",
  "apiCall.agents.showDiff": "Mostrar un diff en el chat",
  "apiCall.agents.showDiffDetail": "Mostrar un diff en el chat",
  "apiCall.agents.offerFile": "Ofrecer un archivo en el editor",
  "apiCall.agents.offerFileDetail": "Ofrecer un archivo en el editor",
  "apiCall.agents.suggestCommand": "Sugerir un comando de terminal",
  "apiCall.agents.suggestCommandDetail": "Sugerir un comando de terminal",
  "apiCall.agents.requestSecret": "Pedir un secreto",
  "apiCall.agents.context": "Consultar el uso del contexto",
  "apiCall.agents.subscription": "Consultar el uso de la suscripción",
  "apiCall.agents.logsSearch": "Buscar en los registros de conversación",
  "apiCall.agents.logsSearchFor": 'Buscar "{query}" en los registros de {who}',
  "apiCall.agents.logsAround":
    "Leer alrededor de una entrada en los registros de {who}",
  "apiCall.agents.logsSession": "Leer una sesión de los registros de {who}",
  "apiCall.agents.logsList": "Listar las sesiones de los registros de {who}",
  "apiCall.agents.instructions": "Leer las instrucciones del agente",
  "apiCall.agentReference.read": "Leer la referencia de la API de la oficina",
  "apiCall.agentReference.readPage":
    "Leer la referencia de la API de la oficina: {page}",
  "apiCall.agents.systemPrompt": "Leer el prompt de sistema del agente",
  "apiCall.agents.clearConversation": "Borrar la conversación de {who}",
  "apiCall.agents.flushQueue": "Vaciar ahora la cola de {who}",
  "apiCall.agents.interrupt": "Interrumpir a {who}",
  "apiCall.agents.resume": "Reanudar una sesión de {who}",
  "apiCall.agents.sessions": "Listar las sesiones de {who}",
  "apiCall.agents.terminal": "Leer la salida del terminal",
  "apiCall.agents.terminalFor": "Leer el terminal de {who}",
  "apiCall.agents.move": "Mover a {who}",
  "apiCall.agents.setManager": "Cambiar el responsable de {who}",
  "apiCall.agents.revive": "Revivir a {who}",
  "apiCall.agents.cancelQueued": "Cancelar un mensaje en cola para {who}",
  "apiCall.agents.readQueue": "Listar los mensajes en cola para {who}",
  "apiCall.agents.editMessage": "Editar un mensaje del chat de {who}",
  "apiCall.apiTokens.list": "Listar los tokens de API",
  "apiCall.apiTokens.create": "Crear un token de API",
  "apiCall.apiTokens.revoke": "Revocar un token de API",
  "apiCall.providerAccounts.check": "Consultar las cuentas de proveedor",
  "apiCall.providerAccounts.signInStart":
    "Empezar el inicio de sesión con el proveedor",
  "apiCall.providerAccounts.signInCancel":
    "Cancelar el inicio de sesión con el proveedor",
  "apiCall.providerAccounts.signOut":
    "Cerrar la sesión de la cuenta de proveedor",
  "apiCall.providerAccounts.refresh": "Actualizar las cuentas de proveedor",
  "apiCall.providerAccounts.signInCode":
    "Enviar el código de inicio de sesión del proveedor",
  "apiCall.users.readMemberPrompt": "Leer instrucciones especiales del miembro",
  "apiCall.users.updatePrompt": "Editar instrucciones especiales del miembro",
  "apiCall.office.readSettings": "Leer la configuración de la oficina",
  "apiCall.office.readMemberUsageStatus":
    "Leer el estado del uso de los miembros",
  "apiCall.office.saveSettings": "Cambiar la configuración de la oficina",
  "apiCall.office.readInstructions": "Leer las instrucciones de la oficina",
  "apiCall.office.saveInstructions": "Cambiar las instrucciones de la oficina",
  "apiCall.rooms.readInstructions": "Leer las instrucciones de la sala",
  "apiCall.githubSync.get": "Leer el enlace de GitHub de una sala",
  "apiCall.githubSync.set": "Enlazar una sala con un repositorio de GitHub",
  "apiCall.githubSync.delete": "Desenlazar una sala de GitHub",
  "apiCall.rooms.saveInstructions": "Cambiar las instrucciones de la sala",
  "apiCall.agents.saveInstructions": "Cambiar las instrucciones del agente",
  "apiCall.users.readInstructions": "Leer las instrucciones del miembro",
  "apiCall.users.saveInstructions": "Cambiar las instrucciones del miembro",
  "apiCall.cronjobs.readInstructions":
    "Leer las instrucciones de las programaciones",
  "apiCall.cronjobs.saveInstructions":
    "Cambiar las instrucciones de las programaciones",
  "apiCall.users.create": "Crear un miembro",
  "apiCall.users.createNamed": "Crear el miembro {name}",
  "apiCall.env.readUser": "Leer el entorno gestionado",
  "apiCall.env.saveUser": "Guardar el entorno gestionado",
  "apiCall.env.readOffice": "Leer el entorno de la oficina",
  "apiCall.env.saveOffice": "Guardar el entorno de la oficina",
  "apiCall.env.namesUser": "Listar los nombres de las variables de un miembro",
  "apiCall.env.setUser": "Guardar una variable",
  "apiCall.env.removeUser": "Eliminar una variable",
  "apiCall.env.namesOffice":
    "Listar los nombres de las variables de la oficina",
  "apiCall.env.setOffice": "Guardar una variable de la oficina",
  "apiCall.env.removeOffice": "Eliminar una variable de la oficina",
  "apiCall.secrets.reissue": "Nuevo sustituto para un secreto",
  "apiCall.secrets.test": "Probar un secreto",
  "apiCall.officeSecrets.reissue":
    "Nuevo sustituto para un secreto de la oficina",
  "apiCall.officeSecrets.test": "Probar un secreto de la oficina",
  "apiCall.mcpServers.test": "Probar un servidor MCP",
  "apiCall.officeMcpServers.test": "Probar un servidor MCP de la oficina",
  "apiCall.secrets.list": "Listar mis secretos",
  "apiCall.secrets.create": "Guardar un secreto",
  "apiCall.secrets.rotate": "Reemplazar el valor de un secreto",
  "apiCall.secrets.update": "Editar un secreto",
  "apiCall.secrets.delete": "Eliminar un secreto",
  "apiCall.officeSecrets.list": "Listar los secretos de la oficina",
  "apiCall.officeSecrets.create": "Guardar un secreto de la oficina",
  "apiCall.officeSecrets.rotate":
    "Reemplazar el valor de un secreto de la oficina",
  "apiCall.officeSecrets.update": "Editar un secreto de la oficina",
  "apiCall.officeSecrets.delete": "Eliminar un secreto de la oficina",
  "apiCall.mcpServers.list": "Listar mis servidores MCP",
  "apiCall.mcpServers.create": "Añadir un servidor MCP",
  "apiCall.mcpServers.update": "Editar un servidor MCP",
  "apiCall.mcpServers.delete": "Eliminar un servidor MCP",
  "apiCall.officeMcpServers.list": "Listar los servidores MCP de la oficina",
  "apiCall.officeMcpServers.create": "Añadir un servidor MCP de la oficina",
  "apiCall.officeMcpServers.update": "Editar un servidor MCP de la oficina",
  "apiCall.officeMcpServers.delete": "Eliminar un servidor MCP de la oficina",
  "apiCall.inbox.messageTokenInbox": "Mensaje enviado al token externo",
  "apiCall.inbox.drain": "Vaciar la bandeja del token de API",
  "apiCall.memory.read": "Leer la memoria",
  "apiCall.connections.agentList": "Leer las notas de las conexiones",
  "apiCall.memory.append": "Añadir a la memoria",
  "apiCall.memory.replace": "Reemplazar la memoria",
  "apiCall.memory.readAgent": "Leer las memorias de este agente",
  "apiCall.memory.readRoom": "Leer las memorias de la sala",
  "apiCall.memory.readOffice": "Leer las memorias de la oficina",
  "apiCall.memory.readMember": "Leer las memorias del miembro",
  "apiCall.memory.readAny": "Leer las memorias",
  "apiCall.memory.saveAgent": "Guardar una memoria para este agente",
  "apiCall.memory.saveRoom": "Guardar una memoria de sala",
  "apiCall.memory.saveOffice": "Guardar una memoria de oficina",
  "apiCall.memory.saveMember": "Guardar una memoria de miembro",
  "apiCall.memory.save": "Guardar una memoria",
  "apiCall.memory.rewriteAgent": "Reescribir las memorias de este agente",
  "apiCall.memory.rewriteRoom": "Reescribir las memorias de la sala",
  "apiCall.memory.rewriteOffice": "Reescribir las memorias de la oficina",
  "apiCall.memory.rewriteMember": "Reescribir las memorias del miembro",
  "apiCall.memory.rewriteAny": "Reescribir las memorias",
  "apiCall.rooms.create": "Crear una sala",
  "apiCall.rooms.createNamed": "Crear la sala {name}",
  "apiCall.rooms.rename": "Renombrar la sala como {name}",
  "apiCall.rooms.setPet": "Poner la mascota de una sala",
  "apiCall.rooms.setSkin": "Poner el aspecto de una sala",
  "apiCall.rooms.update": "Actualizar una sala",
  "apiCall.rooms.close": "Cerrar una sala",
  "apiCall.rooms.updateSettings": "Actualizar los ajustes de la sala",
  "apiCall.rooms.swapDesks": "Intercambiar escritorios en una sala",
  "apiCall.cronjobs.list": "Listar las programaciones",
  "apiCall.cronjobs.create": "Crear una programación",
  "apiCall.cronjobs.read": "Leer una programación",
  "apiCall.cronjobs.systemPrompt": "Leer el prompt de una programación",
  "apiCall.cronjobs.update": "Actualizar una programación",
  "apiCall.cronjobs.delete": "Eliminar una programación",
  "apiCall.cronjobs.listRuns": "Listar las ejecuciones de una programación",
  "apiCall.cronjobs.triggerRun": "Lanzar una ejecución de la programación",
  "apiCall.cronjobs.readRun": "Leer una ejecución de la programación",
  "apiCall.cronjobs.listRecentRuns": "Listar las ejecuciones recientes",
  "apiCall.apps.list": "Listar las apps",
  "apiCall.apps.register": "Registrar una app",
  "apiCall.apps.read": "Leer una app",
  "apiCall.apps.setThumbnail": "Subir la miniatura de la app",
  "apiCall.apps.getThumbnail": "Leer la miniatura de la app",
  "apiCall.apps.update": "Actualizar la app",
  "apiCall.apps.delete": "Eliminar la app",
  "apiCall.apps.logs": "Leer los registros de la app",
  "apiCall.apps.start": "Arrancar la app",
  "apiCall.apps.stop": "Parar la app",
  "apiCall.apps.restart": "Reiniciar la app",
  "apiCall.apps.archive": "Archivar la app",
  "apiCall.apps.unarchive": "Desarchivar la app",
  "apiCall.webhooks.list": "Listar los webhooks",
  "apiCall.webhooks.create": "Crear un webhook",
  "apiCall.webhooks.read": "Leer un webhook",
  "apiCall.webhooks.update": "Actualizar el webhook",
  "apiCall.webhooks.delete": "Eliminar el webhook",
  "apiCall.webhooks.deliveries": "Leer las entregas del webhook",
  "apiCall.webhooks.dryRun": "Probar las reglas del webhook",
  "apiCall.skillUsage.read": "Leer el recuento de uso de habilidades",
  "apiCall.version.check": "Consultar la versión de isomux",
  "apiCall.storage.usage": "Consultar el uso de disco de la oficina",
  "apiCall.storage.prune": "Purgar el historial almacenado",
  "apiCall.storage.compress": "Comprimir conversaciones antiguas",
  "apiCall.backup.settings":
    "Cambiar la configuración de las copias de seguridad",
  "apiCall.usage.tokens": "Consultar el uso de tokens de la oficina",
  "apiCall.body.jq": "cuerpo construido con jq",
  "apiCall.body.jqReads": "cuerpo construido con jq (lee {files})",
  "apiCall.body.heredoc": "cuerpo desde un heredoc",
  "apiCall.body.output": "salida guardada en {file}",
  "apiCall.body.outputAppended": "salida añadida a {file}",
  "apiCall.body.more": "+{count} más",
  "common.copiedNotice": "¡Copiado!",
  "common.tasks": "Tareas",
  "common.avatar": "Avatar",
  "common.agent": "Agente",
  "common.dismiss": "Ocultar",
  "common.you": "Tú",
  "common.send": "Enviar",
  "common.modified": "modificado",
  "common.terminal": "Terminal",
  "common.days.other": "{count} días",
  "common.days.one": "{count} día",
  "common.sender.agent": "{name} · agente",
  "common.sender.agentInRoom": '{name} · agente · Sala "{room}"',
  "common.sender.app": "{name} · app",
  "common.sender.cronjob": "{name} · programación",
  "common.sender.webhook": "{name} · webhook",
  "cards.userMessage.expand": "Expandir mensaje",
  "cards.userMessage.collapse": "Contraer mensaje",
  "cards.userMessage.editAndBranch": "Editar y ramificar",
  "cards.failedEdit.restore": "Recuperar el texto",
  "cards.thinking.label": "Pensando...",
  "cards.toolCall.input": "Entrada",
  "cards.toolCall.output": "Salida",
  "cards.toolCall.denied": "Denegado",
  "cards.toolCall.groupCount": "{count} llamadas a herramientas",
  "cards.toolResult.showMore": "Ver más",
  "cards.toolResult.showLess": "Ver menos",
  "cards.reviewFindings.none": "Sin hallazgos.",
  "cards.fileView.fullSize": "Tamaño completo",
  "cards.fileView.download": "Descargar {file}",
  "cards.fileView.earlierAttachment":
    "El agente ha visto un archivo adjuntado antes en este chat. Haz clic para mostrarlo.",
  "cards.editRequest.open": "Abrir en el editor",
  "cards.editRequest.openHint": "Abrir {path} en el panel lateral del editor",
  "cards.secretRequest.title": "Solicitud de secreto: {name}",
  "cards.secretRequest.personal":
    "Se guarda en los secretos del responsable de este agente.",
  "cards.secretRequest.office":
    "Secreto de la oficina: lo guarda un propietario de la oficina.",
  "cards.secretRequest.hint":
    "El valor no entra en el chat. El agente recibe un sustituto.",
  "cards.secretRequest.save": "Guardar secreto",
  "cards.secretRequest.decline": "Rechazar",
  "cards.secretRequest.saved":
    "Guardado. El agente recibe un sustituto en su próximo inicio.",
  "cards.secretRequest.declined": "Rechazada.",
  "cards.secretRequest.declineFailed": "No se pudo rechazar la solicitud.",
  "cards.secretRequest.closed":
    "Esta solicitud está cerrada. El agente puede volver a pedirlo.",
  "cards.secretRequest.forbidden":
    "Solo el responsable del agente responde a esta solicitud, o un propietario de la oficina si es un secreto de la oficina.",
  "cards.terminalCommand.copy": "Copiar en la terminal",
  "cards.tool.noOutput": "(sin salida)",
  "cards.tool.morePaths": "{path} +{count} más",
  "cards.terminalCommand.copyHint":
    "Abre el panel de la terminal y escribe este comando en el prompt (no se ejecuta solo)",
  "cards.markdown.mermaidError": "Error de Mermaid",
  "cards.markdown.mermaidLoadFailed": "No se ha podido cargar mermaid",
  "cards.diff.status.added": "añadido",
  "cards.diff.status.deleted": "eliminado",
  "cards.diff.status.renamed": "renombrado",
  "cards.diff.status.copied": "copiado",
  "cards.diff.status.untracked": "sin seguimiento",
  "cards.diff.status.binary": "binario",
  "cards.diff.reasonTruncated":
    "El parche total pasaba de 2 MB, así que el contenido del diff no se ha enviado al navegador. Vuelve a ejecutar /isomux-diff con menos archivos en el árbol de trabajo, o abre este archivo en tu editor.",
  "cards.diff.reasonBinary":
    "Archivo binario - no hay diff de texto que mostrar.",
  "cards.diff.reasonUntracked":
    "Archivo sin seguimiento demasiado grande para sintetizar un parche (>1 MB). Ábrelo en tu editor, o haz `git add` y vuelve a ejecutarlo.",
  "cards.diff.reasonNoPatch": "No hay contenido de parche para este archivo.",
  "cards.diff.closeHint": "Cerrar (Esc)",
  "cards.diff.openTruncated": "Abrir (parche no enviado)",
  "cards.diff.openBinary": "Abrir (binario)",
  "cards.diff.openUntracked": "Abrir (sin seguimiento, demasiado grande)",
  "cards.diff.openLines": "Abrir ({lines} líneas)",
  "cards.diff.unified": "Unificado",
  "cards.diff.split": "Dividido",
  "cards.diff.collapseAll": "Plegar todo",
  "cards.diff.expandAll": "Desplegar todo",
  "cards.diff.summaryOnly": "· parche > 2 MB · solo el resumen",
  "cards.diff.headerLine": "+{additions} -{deletions} en {files}",
  "cards.diff.fileCount.one": "{count} archivo",
  "cards.diff.fileCount.other": "{count} archivos",
  "contextBattery.detail":
    "Contexto: {tokens} / {maxTokens} tokens usados (queda un {remaining}%).",
  "contextBattery.nudge":
    "Puedes pedirle al agente que cierre el trabajo, o usar /clear para empezar una sesión nueva.",
  "contextBattery.unknown":
    "El uso del contexto todavía no se ha medido. Se actualiza cuando el agente termina un turno.",
  "contextBattery.ariaKnown":
    "Batería de contexto: queda un {remaining}%. Toca para ver los detalles.",
  "contextBattery.ariaUnknown":
    "El uso del contexto todavía no se ha medido. Toca para ver los detalles.",
  "logView.state.thinking": "Pensando",
  "logView.state.toolExecuting": "Ejecutando una herramienta",
  "logView.pendingPrompt.permission": "Esperando un permiso",
  "logView.pendingPrompt.resume": "Esperando que elijas una sesión",
  "logView.pendingPrompt.model": "Esperando que elijas un modelo",
  "logView.pendingPrompt.effort": "Esperando que elijas un esfuerzo",
  "logView.pendingPrompt.cronjob": "Esperando que elijas una programación",
  "logView.abort": "Abortar",
  "logView.abortTitle": "Abortar (Ctrl+C)",
  "logView.restartingSession": "Reiniciando la sesión...",
  "logView.queue.flushNow": "Enviar ahora",
  "logView.queue.flushHint":
    "Enviar ahora los mensajes en cola - interrumpe el turno actual (Ctrl+Enter)",
  "logView.queue.cancel": "Cancelar este mensaje en cola",
  "logView.interaction.current": "Actual",
  "logView.interaction.failed": "No se ha podido aplicar esa opción.",
  "logView.nav.agentTitle": "Ajustes del agente",
  "logView.nav.copyTitle": "Copiar todo el chat",
  "logView.nav.avatarTitle": "Ver el avatar",
  "logView.nav.editor": "Editor",
  "logView.nav.editorTitle": "Abrir el editor de archivos (Ctrl+E)",
  "logView.nav.terminalTitle": "Abrir la terminal (Ctrl+`)",
  "logView.nav.endConversation": "Terminar",
  "logView.nav.endConversationTitle":
    "Terminar la conversación. Puedes reanudarla más tarde con /resume.",
  "logView.backToOffice": "← Volver a la oficina",
  "logView.backToOfficeTitle": "Volver a la oficina (Esc)",
  "logView.backToBackRoom": "← Trastienda",
  "logView.backToBackRoomTitle": "Volver a la trastienda (Esc)",
  "logView.backRoomStrip":
    "En la trastienda de {room}. La gente habla con el frente:",
  "logView.noTopic": "Sin tema",
  "logView.editTopic": "Haz clic para editar el tema",
  "logView.regenerateTopic": "Regenerar el tema a partir de la conversación",
  "logView.lastMessagePrefix": "↑ Tú:",
  "logView.emptyStart": "Envía un mensaje para empezar una conversación o",
  "logView.emptyResume": "reanuda una anterior",
  "logView.outbox.sending": "Enviando",
  "logView.outbox.notSent": "No enviado",
  "logView.outbox.resend": "Reenviar",
  "logView.outbox.networkError": "No se ha podido contactar con el servidor.",
  "logView.outbox.interrupted":
    "La página se recargó antes de que el servidor lo confirmara.",
  "logView.outbox.saveFailed":
    "No enviado: este navegador no ha podido guardar antes una copia. Tu mensaje sigue en la caja.",
  "logView.sendFailedBanner":
    "No se ha podido enviar - reconectando. Tu mensaje sigue en la caja; vuelve a intentarlo cuando desaparezca este aviso.",
  "logView.editFailedBanner":
    "No se ha podido enviar la edición: {error}. Tu texto ha vuelto al cuadro de mensaje.",
  "logView.attachTooLarge": "Archivo demasiado grande (máximo 200MB)",
  "logView.attachUploading": "subiendo…",
  "logView.attachFiles": "Adjuntar archivos",
  "logView.scrollToBottom": "Ir al final",
  "logView.composer.type": "Escribe un mensaje o / para los comandos...",
  "logView.composer.typeShort": "Escribe un mensaje...",
  "logView.composer.queueShort": "Escribe para poner en cola...",
  "logView.composer.queueLong":
    "Escribe para poner en cola - se envía cuando acabe el turno actual · {modifier}Enter para enviarlo ahora",
  "logView.composer.editing": "Editando el mensaje de arriba...",
  "logView.composer.queue": "Poner el mensaje en cola",
  "logView.cite.label": "Citar",
  "logView.cite.hint": "Citar el texto seleccionado en el mensaje",
  "logView.skills.title": "Habilidades y comandos",
  "logView.skills.buttonLabel": "Ha",
  "logView.uploadFailed": "Error al subir ({status})",
  "logView.skills.filter": "Filtrar habilidades y comandos...",
  "logView.skills.noMatch": "No hay habilidades ni comandos que coincidan",
  "logView.skills.group.mostUsed": "Más usados",
  "logView.skills.group.commands": "Comandos",
  "logView.skills.group.bundled": "Incluidos",
  "logView.skills.group.project": "Proyecto",
  "logView.skills.group.plugin": "Plugin",
  "logView.voice.talkHint": "Haz clic para hablar (Ctrl+Espacio para mantener)",
  "logView.voice.blocked":
    "La entrada de voz está bloqueada. Revisa el permiso del micrófono para este sitio en tu navegador.",
  "logView.voice.noMicrophone": "No se ha encontrado ningún micrófono.",
  "logView.voice.network":
    "La entrada de voz no ha podido conectar con el servicio de voz.",
  "logView.voice.failed": "La entrada de voz ha fallado.",
  "logView.voice.speak": "Leer en voz alta",
  "logView.voice.stop": "Parar",
  "logView.voice.noVoice":
    "No hay ninguna voz en {language} instalada en este dispositivo",
  "logView.voice.language.en": "inglés",
  "logView.voice.language.es": "español",
  "logView.voice.language.ca": "catalán",
  "logView.voice.language.zh": "Chino simplificado",
  "logView.voice.httpsTitle": "La entrada de voz necesita HTTPS",
  "logView.voice.httpsStep1":
    "Activa HTTPS en tu <console>consola de administración de Tailscale</console> (página DNS), y luego ejecuta esto en el host (usa la terminal integrada):",
  "logView.voice.httpsStep2":
    "Visita la URL HTTPS que imprime Tailscale (p. ej. <url>{example}</url>).",
  "voice.openVariables": "Abrir Variables",
  "voice.keyRejected": "OpenAI rechazó la clave.",
  "voice.retry": "Reintentar",
  "voice.useBrowser": "Usar las voces del navegador",
  "voice.mic.keyMissing":
    "Añade OPENAI_VOICE_API_KEY para usar el micrófono de OpenAI.",
  "voice.mic.tooLarge": "La grabación supera los 25 MB.",
  "voice.mic.rejected": "OpenAI no pudo transcribir la grabación.",
  "voice.mic.failed": "La transcripción falló.",
  "voice.mic.limitReached": "La grabación se detuvo a los {minutes} minutos.",
  "voice.mic.kept": "La grabación se guarda en esta página.",
  "voice.mic.transcribing": "Transcribiendo",
  "voice.speak.keyMissing":
    "Añade OPENAI_VOICE_API_KEY para leer en voz alta con OpenAI.",
  "voice.speak.rejected": "OpenAI no pudo leer esta respuesta.",
  "voice.speak.failed": "La lectura en voz alta falló.",
  "panels.resizer.label": "Cambiar el ancho del panel lateral",
  "panels.terminal.ready": "Lista",
  "panels.terminal.busy": "Ocupada: {process}",
  "panels.terminal.interrupt": "Interrumpir",
  "panels.terminal.interruptHint": "Interrumpir el comando en primer plano",
  "panels.terminal.restart": "Reiniciar",
  "panels.terminal.recorded":
    "Este terminal se graba. Los propietarios de la oficina pueden reproducirlo.",
  "panels.terminal.envStale":
    "Los secretos o las variables cambiaron. Reinicia este terminal para usarlos.",
  "panels.terminal.restartHint": "Reiniciar la terminal",
  "panels.terminal.close": "Cerrar la terminal",
  "panels.terminal.sendToChat": "Enviar al chat",
  "panels.terminal.sendToChatHint":
    "Insertar el texto seleccionado en el chat como bloque de código",
  "panels.terminal.shellExited": "La shell ha terminado ({code})",
  "panels.terminal.unavailable": "Terminal no disponible",
  "panels.terminal.busyIssue":
    "No se ha enviado: {process} está usando la terminal",
  "panels.terminal.paste": "Pegar",
  "panels.terminal.pastePrompt": "Pegar:",
  "panels.editor.close": "Cerrar el editor",
  "panels.editor.closeTab": "Cerrar la pestaña",
  "panels.editor.selectFile": "Elegir un archivo",
  "panels.editor.saveHint": "Ctrl+S para guardar",
  "panels.editor.saved": "guardado",
  "panels.editor.recentlyOpened": "Abiertos recientemente",
  "panels.editor.staleBanner":
    "El archivo ha cambiado en el disco desde que lo abriste. Si lo recargas, perderás tus cambios.",
  "panels.editor.externalBanner":
    "El archivo ha cambiado por fuera - perderás tus cambios si lo recargas.",
  "panels.editor.deletedBanner":
    "El archivo se ha eliminado del disco. Si lo guardas, se recreará a partir de este búfer.",
  "panels.editor.overwrite": "Sobrescribir",
  "panels.editor.reload": "Recargar",
  "panels.editor.saveToRecreate": "Guardar para recrearlo",
  "panels.editor.saveFailed": "No se ha podido guardar: {reason}",
  "panels.editor.saveError": "no se ha podido guardar",
  "panels.editor.openError": "{path}: {reason}",
  "panels.editor.openFailed": "no se ha podido abrir",
  "subscription.plan": "Plan: {plan}",
  "subscription.caveat": "Esto es de toda la cuenta, no de cada agente.",
  "subscription.chooserHint": "Qué límite sigue el número:",
  "subscription.autoChoice": "Automático (el más ajustado)",
  "subscription.unknown":
    "El uso del plan todavía no se ha informado. Se actualiza cuando el agente termina un turno - las sesiones sin límites de plan (clave de API, Bedrock, Vertex) no informan de ninguno.",
  "subscription.readingAge": "Lectura tomada hace {age}.",
  "subscription.ariaTracked":
    "Cupo del plan {label}: usado un {used}%. Toca para ver los detalles.",
  "subscription.ariaTrackedPinned":
    "Cupo del plan {label}: usado un {used}%, fijado. Toca para ver los detalles.",
  "subscription.ariaUnknown":
    "El uso del plan todavía no se ha informado. Toca para ver los detalles.",
  "subscription.window.used": "{label}: usado un {percent}%",
  "subscription.window.usedResets":
    "{label}: usado un {percent}% - se reinicia el {at}",
  "subscription.window.usedResetsIn":
    "{label}: usado un {percent}% - se reinicia el {at} (dentro de {duration})",
  "subscription.duration.hours.one": "{count} hora",
  "subscription.duration.hours.other": "{count} horas",
  "subscription.duration.minutes": "{count} min",
  "subscription.duration.daysHours": "{days} y {hours}",
  "subscription.duration.hoursMinutes": "{hours} y {minutes}",
  "logView.editAgent": "Editar el agente",
  "logView.pickModel": "Elegir un modelo",
  "logView.goneModelTitle": "OpenCode ya no ofrece {model}. Elige otro modelo.",
  "panels.editor.noFileOpen": "Ningún archivo abierto",
  "panels.editor.emptyHint":
    "Ningún archivo abierto. Usa <code>{command}</code> o pide al agente que te envíe uno.",
  "logView.queue.count": "{count} en cola",
  "logView.queue.chip": "en cola · {label}",
  "logView.queue.attachments.one": "{count} adjunto",
  "logView.queue.attachments.other": "{count} adjuntos",
  "logView.backendTitle": "Motor: {backend}",
  "cards.markdown.rendering": "Dibujando el diagrama…",
  "cards.subagent.pill": "subagente",
  "cards.subagent.pillTyped": "subagente · {type}",
  "cards.subagent.title": "Subagente",
  "cards.subagent.titleTyped": "Subagente ({type})",
  "cards.subagent.titleDescribed": "Subagente: {description}",
  "cards.subagent.titleTypedDescribed": "Subagente ({type}): {description}",
  "cards.subagent.pillBackground": "en segundo plano · {description}",
  "cards.subagent.pillBackgroundTyped": "en segundo plano · {type}",
  "cards.subagent.pillBackgroundPlain": "subagente en segundo plano",
  "cards.subagent.pillDescribed": "subagente · {description}",
  "cards.subagent.titleBackground": "Subagente en segundo plano",
  "cards.subagent.titleBackgroundTyped": "Subagente en segundo plano ({type})",
  "cards.subagent.titleBackgroundDescribed":
    "Subagente en segundo plano: {description}",
  "cards.subagent.titleBackgroundTypedDescribed":
    "Subagente en segundo plano ({type}): {description}",
  "cards.subagent.jumpHint": "Haz clic para ver la tarjeta que lo inició.",
  "cards.fileView.viewedFile": "Ha visto {file} (haz clic para mostrarlo)",
  "cards.fileView.viewedImages":
    "Ha visto {count} imágenes adjuntas (haz clic para mostrarlas)",
  "office.newRoom.door": "Nueva sala",
  "office.newRoom.title": "¿Abrir una nueva sala?",
  "office.newRoom.confirm": "Abrir sala",
  "office.newRoom.failed": "No se ha podido abrir la sala. Inténtalo de nuevo.",
  "office.tabs.scrollLeft": "Desplazar las salas a la izquierda",
  "office.tabs.scrollRight": "Desplazar las salas a la derecha",
  "office.tabs.roomSettings": "Haz doble clic para la configuración de la sala",
  "office.tabs.closeEmptyRoom": "Cerrar la sala vacía",
  "office.tabs.newRoom": "Crear una sala nueva",
  "office.tabs.tuckedRooms": "Salas recogidas",
  "office.tabs.tuck": "Recoger",
  "office.tabs.onlineUsers.one": "{count} miembro en línea",
  "office.tabs.onlineUsers.other": "{count} miembros en línea",
  "office.zoom.in": "Acercar",
  "office.zoom.inShortcut": "Acercar (+)",
  "office.zoom.out": "Alejar",
  "office.zoom.outShortcut": "Alejar (-)",
  "office.zoom.reset": "Restablecer la vista (0)",
  "office.zoom.resetAria": "Restablecer la vista",
  "office.openWebsite": "Abrir isomux.com",
  "office.skin.office": "Oficina",
  "office.skin.hospital": "Hospital",
  "office.decor.preset": "Preajuste",
  "office.decor.walls": "Color de la sala",
  "office.decor.walls.office": "Tema",
  "office.decor.walls.clinic": "Salvia",
  "office.decor.walls.teal": "Turquesa",
  "office.decor.walls.sky": "Cielo",
  "office.decor.walls.lilac": "Lila",
  "office.decor.walls.rose": "Rosa",
  "office.decor.walls.clay": "Arcilla",
  "office.decor.curtains": "Cortinas de la ventana",
  "office.decor.curtains.tied": "Cortinas",
  "office.decor.sill": "Alféizar",
  "office.decor.sill.trailing": "Planta colgante",
  "office.decor.sill.blossom": "Jarrón con flores",
  "office.decor.wallArt": "Pared derecha",
  "office.decor.wallArt.neon": "Letrero de neón",
  "office.decor.wallArt.name": "Nombre de la sala",
  "office.namePlate.title": "{name} - configuración de la sala",
  "office.decor.wallArt.landscape": "Paisaje",
  "office.decor.wallArt.chart": "Gráfica médica",
  "office.decor.trim": "Zócalo",
  "office.decor.trim.rail": "Barra",
  "office.decor.cabinet": "Armario de pared",
  "office.decor.cabinet.firstAid": "Botiquín",
  "office.decor.floorPlant": "Planta de suelo",
  "office.decor.floorPlant.plant": "Planta en maceta",
  "office.decor.ward": "Mobiliario hospitalario",
  "office.decor.ward.beds": "Cama",
  "office.decor.none": "Ninguno",
  "office.decor.coat": "Pelaje",
  "office.pet.label": "Mascota de la sala",
  "office.pet.species.cat": "Gato",
  "office.pet.species.dog": "Perro",
  "office.pet.species.rabbit": "Conejo",
  "office.pet.species.tortoise": "Tortuga",
  "office.pet.coat": "{species} {number}",
  "office.pet.coatAria": "{species}, pelaje {number}",
  "office.desk.swapBadge": "INTERCAMBIAR",
  "office.status.working": "trabajando",
  "office.status.waiting": "esperando",
  "office.status.error": "con error",
  "office.status.idle": "inactivos",
  "office.backRoom.tooltip.one": "Trastienda · {count} agente",
  "office.backRoom.tooltip.other": "Trastienda · {count} agentes",
  "office.backRoom.dropBadge": "Mover a la trastienda",
  "office.backRoom.fullBadge": "La trastienda está llena",
  "office.backRoom.title": "Trastienda",
  "office.backRoom.backTo": "← {room}",
  "office.backRoom.backToTitle": "Volver a {room} (Esc)",
  "office.backRoom.newAgent": "+ Nuevo agente",
  "office.backRoom.sign": "TRASTIENDA",
  "office.backRoom.boardTitle": "HOY",
  "office.backRoom.boardCount": "{count} EN TURNO",
  "office.status.errShort": "error",
  "office.hints.tap": "TOCAR → abrir",
  "office.hints.longPress": "MANTENER PULSADO → acciones",
  "office.hints.pinch": "PELLIZCAR → zoom",
  "office.hints.dragZoomed": "ARRASTRAR (con zoom) → desplazar",
  "office.hints.click": "CLIC → abrir el agente",
  "office.hints.dragDeskTrapDoor":
    "ARRASTRAR EL ESCRITORIO → intercambiar, o mover a una puerta o a la trampilla",
  "office.hints.dragDesk":
    "ARRASTRAR EL ESCRITORIO → intercambiar, o mover a una puerta",
  "office.hints.dragAgent": "ARRASTRAR EL AGENTE → mover al frente (escalera)",
  "office.hints.wheel": "RUEDA / +- → zoom",
  "office.hints.dragFloor": "ARRASTRAR EL SUELO → desplazar",
  "office.hints.rightClick": "CLIC DERECHO → acciones",
  "office.hints.resetView": "0 → restablecer la vista",
  "office.pendingPrompt.permission": "permiso",
  "office.pendingPrompt.resume": "sesión",
  "office.pendingPrompt.model": "modelo",
  "office.pendingPrompt.effort": "esfuerzo",
  "office.pendingPrompt.cronjob": "programación",
  "office.pet.default": "Predeterminada",
  "contextMenu.editAgent": "Editar el agente...",
  "contextMenu.newConversation": "Conversación nueva",
  "contextMenu.newEngineConversation": "Conversación nueva de {engine}",
  "contextMenu.resume": "Reanudar",
  "common.current": "(actual)",
  "common.date": "{date}",
  "common.value": "{value}",
  "contextMenu.branched": "(ramificada)",
  "contextMenu.killAgent": "Eliminar el agente",
  "contextMenu.moveToBackRoom": "Mover a la trastienda",
  "contextMenu.moveToBackRoomFull": "Mover a la trastienda (llena)",
  "contextMenu.moveToFront": "Mover al frente",
  "contextMenu.moveToFrontFull": "Mover al frente (lleno)",
  "app.reconnecting": "Reconectando…",
  "app.uiBuild.outOfDate": "Esta página no está actualizada",
  "themes.dark": "Oscuro",
  "themes.light": "Claro",
  "themes.nord": "Nord",
  "themes.dracula": "Dracula",
  "themes.solarizedDark": "Solarized Dark",
  "themes.solarizedLight": "Solarized Light",
  "common.unknownSize": "tamaño desconocido",
  "common.edit": "Editar",
  "schedules.tab.runs": "ejecuciones",
  "schedules.tab.cronjobs": "programaciones",
  "schedules.anyMoment": "en cualquier momento",
  "schedules.createdByFor": "{creator} · para {user}",
  "schedules.running": "en curso…",
  "schedules.newButton": "+ Nueva",
  "schedules.filterLabel": "Programación:",
  "schedules.empty":
    'Aún no hay programaciones. Haz clic en "+ Nueva" para crear una.',
  "schedules.runsEmpty": "Aún no hay ejecuciones.",
  "schedules.enabledToggle": "Activada (haz clic para pausarla)",
  "schedules.pausedToggle": "En pausa (haz clic para activarla)",
  "schedules.inFlight": "en curso",
  "schedules.runNow": "Ejecutar ahora",
  "schedules.run": "Ejecutar",
  "schedules.deleted": "(eliminada)",
  "schedules.col.name": "NOMBRE",
  "schedules.col.schedule": "PROGRAMACIÓN",
  "schedules.col.lastRun": "ÚLTIMA",
  "schedules.col.nextRun": "SIGUIENTE",
  "schedules.col.runs": "EJECUCIONES",
  "schedules.col.by": "POR",
  "schedules.col.status": "E",
  "schedules.col.trigger": "D",
  "schedules.col.started": "INICIO",
  "schedules.col.preview": "VISTA PREVIA",
  "schedules.col.duration": "DURACIÓN",
  "schedules.prevPage": "← Anterior",
  "schedules.nextPage": "Siguiente →",
  "schedules.paused": "en pausa",
  "schedules.status.running": "En curso",
  "schedules.status.completed": "Completada",
  "schedules.status.failed": "Fallida",
  "schedules.status.timedOut": "Tiempo agotado",
  "schedules.status.skipped": "Omitida",
  "schedules.trigger.manual": "manual",
  "schedules.trigger.manualBy": "manual · {who}",
  "schedules.trigger.scheduled": "programada",
  "schedules.trigger.webhook": "webhook",
  "schedules.trigger.webhookBy": "webhook · {name}",
  "schedules.tab.webhooks": "webhooks",
  "webhooks.newButton": "+ Nuevo webhook",
  "webhooks.empty":
    "Aún no hay webhooks. Un webhook permite que un servicio como GitHub envíe un mensaje a un agente o ejecute una programación.",
  "webhooks.loadFailed": "No se pudieron cargar los webhooks.",
  "webhooks.refresh": "Actualizar",
  "webhooks.back": "Webhooks",
  "webhooks.notFound": "Este webhook ya no existe.",
  "webhooks.enabled": "Activado",
  "webhooks.noDeliveries": "sin entregas",
  "webhooks.col.name": "NOMBRE",
  "webhooks.col.target": "DESTINO",
  "webhooks.col.lastDelivery": "ÚLTIMA ENTREGA",
  "webhooks.secretMissingShort": "Necesita un secreto nuevo",
  "webhooks.rejectedShort": "Se rechazaron algunas entregas",
  "webhooks.secretFailed": "No se pudo leer el secreto.",
  "webhooks.openDelivery": "Abrir la entrega",
  "webhooks.target.title": "Destino",
  "webhooks.target.agent": "Agente: {name}",
  "webhooks.target.cronjob": "Programación: {name}",
  "webhooks.target.unavailable": "{id} (no disponible)",
  "webhooks.target.noteLine": "Nota: {note}",
  "webhooks.outcome.pending": "en curso",
  "webhooks.outcome.ping": "ping",
  "webhooks.outcome.badPayload": "contenido no válido",
  "webhooks.outcome.noMatch": "sin coincidencia",
  "webhooks.outcome.dispatchLimited": "límite alcanzado",
  "webhooks.outcome.targetUnavailable": "destino no disponible",
  "webhooks.outcome.dispatched": "entregado",
  "webhooks.setup.github": "Configurar en GitHub",
  "webhooks.setup.generic": "Configurar el remitente",
  "webhooks.setup.url": "URL de carga útil (Payload URL)",
  "webhooks.setup.reach":
    "GitHub debe poder llegar a esta dirección desde internet.",
  "webhooks.setup.reachGeneric":
    "El remitente debe poder llegar a esta dirección desde internet.",
  "webhooks.setup.noPublicAddress":
    "Esta oficina no tiene dirección pública, así que ningún servicio externo puede llegar a ella.",
  "webhooks.setup.contentType": "Tipo de contenido",
  "webhooks.setup.signatureHeader": "Cabecera de firma",
  "webhooks.setup.secret": "Secreto",
  "webhooks.setup.copyFailed": "No se pudo copiar. Usa Mostrar.",
  "webhooks.setup.show": "Mostrar",
  "webhooks.setup.hide": "Ocultar",
  "webhooks.setup.rotate": "Rotar el secreto",
  "webhooks.setup.rotateWarning":
    "El secreto anterior deja de funcionar al instante.",
  "webhooks.setup.rotateYes": "Rotar",
  "webhooks.setup.secretMissing":
    "Necesita un secreto nuevo: las copias de seguridad no guardan secretos. Rótalo y pega el secreto nuevo en el remitente.",
  "webhooks.setup.secretMembersOnly":
    "Solo el propietario del webhook y los propietarios de la oficina pueden ver el secreto.",
  "webhooks.setup.events": "Eventos",
  "webhooks.setup.eventsHint":
    'Elige "Let me select individual events" y selecciona estos:',
  "webhooks.setup.everything":
    'Una regla acepta todos los eventos. En GitHub, elige "Send me everything".',
  "webhooks.setup.unsigned":
    "El nombre del evento no está firmado. Una regla que inicia trabajo real también debe comprobar un campo de la carga útil que solo tenga ese evento.",
  "webhooks.rules.title": "Reglas",
  "webhooks.rules.none": "Sin reglas: ninguna entrega llega al destino.",
  "webhooks.rules.ruleN": "Regla {n}",
  "webhooks.rules.event": "Evento",
  "webhooks.rules.match": "Coincidencia (ruta en la carga útil = valor exacto)",
  "webhooks.rules.args": "Argumentos (nombre = plantilla)",
  "webhooks.counters.title": "Rechazadas antes de comprobar la firma",
  "webhooks.counters.since": "Desde {time}.",
  "webhooks.counters.none": "Ninguna desde {time}.",
  "webhooks.counters.last": "última {time}",
  "webhooks.counter.disabled": "en pausa",
  "webhooks.counter.method": "no es POST",
  "webhooks.counter.secretMissing": "sin secreto",
  "webhooks.counter.rateLimited": "límite alcanzado",
  "webhooks.counter.bodyTooLarge": "cuerpo demasiado grande",
  "webhooks.counter.badSignature": "firma incorrecta",
  "webhooks.dryRun.title": "Probar las reglas",
  "webhooks.dryRun.hint":
    "Pega una carga útil, por ejemplo de Recent Deliveries en GitHub. No se envía nada ni se registra nada.",
  "webhooks.dryRun.event": "Evento",
  "webhooks.dryRun.payload": "Carga útil (JSON)",
  "webhooks.dryRun.run": "Probar",
  "webhooks.dryRun.notObject": "La carga útil debe ser un objeto JSON.",
  "webhooks.dryRun.failed": "La prueba falló.",
  "webhooks.dryRun.ping": "Un ping. Se registra y nunca llega a una regla.",
  "webhooks.dryRun.noMatch": "Ninguna regla coincide.",
  "webhooks.dryRun.match": "Coincide la regla {n}.",
  "webhooks.dryRun.block": "Lo que recibe el destino",
  "webhooks.deliveries.title": "Entregas",
  "webhooks.deliveries.empty": "Aún no hay entregas.",
  "webhooks.deliveries.failed": "No se pudieron cargar las entregas.",
  "webhooks.deliveries.missingRow":
    "La entrega de esta ejecución ya no está en el registro.",
  "webhooks.deliveries.more": "Mostrar todas",
  "webhooks.deliveries.col.time": "HORA",
  "webhooks.deliveries.col.event": "EVENTO",
  "webhooks.deliveries.col.outcome": "RESULTADO",
  "webhooks.deliveries.col.rule": "REGLA",
  "webhooks.deliveries.col.args": "ARGS",
  "webhooks.deliveries.attempts.one": "{count} intento",
  "webhooks.deliveries.attempts.other": "{count} intentos",
  "webhooks.deliveries.duplicates.one": "{count} copia ignorada",
  "webhooks.deliveries.duplicates.other": "{count} copias ignoradas",
  "webhooks.deliveries.openRun": "Abrir la ejecución",
  "webhooks.deliveries.openChat": "Abrir el chat",
  "webhooks.dialog.newTitle": "Nuevo webhook",
  "webhooks.dialog.editTitle": "Editar el webhook",
  "webhooks.dialog.name": "Nombre",
  "webhooks.dialog.nameHint": "Minúsculas, dígitos y guiones.",
  "webhooks.dialog.scheme": "Remitente",
  "webhooks.dialog.schemeGithub": "GitHub",
  "webhooks.dialog.schemeGeneric": "Otro (firma HMAC-SHA256)",
  "webhooks.dialog.schemeFixed":
    "El remitente no se puede cambiar después de crear el webhook.",
  "webhooks.dialog.eventHeader": "Cabecera del evento (opcional)",
  "webhooks.dialog.deliveryHeader": "Cabecera del id de entrega (opcional)",
  "webhooks.dialog.targetAgent": "Agente",
  "webhooks.dialog.targetCronjob": "Programación",
  "webhooks.dialog.pickAgent": "Elige un agente",
  "webhooks.dialog.pickCronjob": "Elige una programación",
  "webhooks.dialog.noCronjobs": "No gestionas ninguna programación.",
  "webhooks.dialog.cronjobHint":
    "Cada entrega inicia una ejecución, también cuando la programación está en pausa.",
  "webhooks.dialog.note": "Nota para el agente (opcional)",
  "webhooks.dialog.noteHint":
    "El agente la lee antes de los datos de la entrega.",
  "webhooks.dialog.noteBrackets":
    "La nota no puede contener corchetes angulares.",
  "webhooks.dialog.rulesHint":
    'Gana la primera regla que coincide. El evento "*" coincide con todos los eventos. Cada entrega que llega al destino cuesta un turno, así que filtra con precisión.',
  "webhooks.dialog.addRule": "+ Añadir regla",
  "webhooks.dialog.addMatch": "+ Añadir condición",
  "webhooks.dialog.addArg": "+ Añadir argumento",
  "webhooks.dialog.moveUp": "Subir",
  "webhooks.dialog.moveDown": "Bajar",
  "webhooks.dialog.removeRule": "Quitar la regla",
  "webhooks.dialog.removeRow": "Quitar",
  "webhooks.dialog.create": "Crear",
  "schedules.runNumber": "Ejecución n.º {id}",
  "schedules.promptLabel": "PROMPT",
  "schedules.snapshot":
    "cwd: {cwd} · modelo: {model} · esfuerzo: {effort} · permiso: {permission}",
  "schedules.errorLine": "Error: {reason}",
  "schedules.runSkipped": "Esta ejecución se omitió.",
  "schedules.noEntries": "No hay entradas de registro.",
  "schedules.runningDots": "En curso...",
  "schedules.editingAbove": "Editando el mensaje de arriba...",
  "schedules.followUp": "Enviar un seguimiento",
  "schedules.waitToFollowUp":
    "Ejecución en curso: espera a que termine antes de enviar un seguimiento.",
  "schedules.skippedNoSession":
    "Las ejecuciones omitidas no tienen ninguna sesión que reanudar.",
  "schedules.noSession":
    "Esta ejecución no se puede reanudar (no se estableció ninguna sesión).",
  "common.back": "Atrás",
  "apps.openApp": "Abrir la app",
  "apps.openOnNetwork": "Abrir en esta red",
  "apps.empty": "Aún no hay apps.",
  "apps.filter.onlyMine": "Solo las mías",
  "apps.filter.noMatch": "Ninguna app coincide con estos filtros.",
  "roomFilter.title": "Filtrar por sala",
  "roomFilter.all": "Todas las salas",
  "roomFilter.none": "Sin sala",
  "schedules.noMatch": "Ninguna programación coincide con este filtro.",
  "webhooks.noMatch": "Ningún webhook coincide con este filtro.",
  "dialogs.schedule.room": "Sala",
  "dialogs.schedule.roomHint":
    "Los miembros de la sala ven esta programación y sus ejecuciones.",
  "apps.unavailable.needsLinux":
    "El alojamiento de apps necesita Linux con systemd, así que no está disponible en este ordenador.",
  "apps.loadFailed": "No se pudieron cargar las apps.",
  "apps.deleteFailed": "No se pudo eliminar.",
  "apps.logReadFailed": "No se pudo leer el registro.",
  "apps.state.running": "en marcha",
  "apps.state.starting": "arrancando",
  "apps.state.stopped": "parada",
  "apps.state.failed": "fallida",
  "apps.state.unknown": "desconocido",
  "apps.meta.createdBy": "creada por",
  "apps.meta.owner": "propietario",
  "apps.openAgent": "Abrir el agente",
  "apps.commandIn": "en {cwd}",
  "apps.verbTitle.start": "Poner la app en marcha",
  "apps.verbTitle.restart": "Parar la app y volver a arrancarla",
  "apps.delete": "eliminar",
  "apps.cancel": "cancelar",
  "apps.logEmpty": "Aún no hay nada en el registro.",
  "apps.confirmDelete":
    "¿Eliminar {name}? Sus datos no se borran: se mueven a {path} en el disco de la oficina.",
  "tasks.status.open": "Abierta",
  "tasks.status.inProgress": "En curso",
  "tasks.status.done": "Hecha",
  "tasks.status.obsolete": "Obsoleta",
  "tasks.unknownRoom": "Sala desconocida",
  "tasks.newTask": "Tarea nueva",
  "tasks.idCopied": "¡Copiado!",
  "tasks.copyId": "Copiar el ID de la tarea",
  "tasks.field.title": "Título",
  "tasks.field.createIn": "Crear en",
  "tasks.field.room": "Sala",
  "tasks.field.description": "Descripción",
  "tasks.field.priority": "Prioridad",
  "tasks.field.status": "Estado",
  "tasks.field.assignee": "Responsable",
  "tasks.global": "Global (toda la oficina)",
  "tasks.moveToRoom": "Mover esta tarea a otra sala",
  "tasks.priorityNone": "Ninguna",
  "tasks.unassigned": "Sin responsable",
  "tasks.showRecentAgents": "Mostrar solo los agentes recientes",
  "tasks.showAllAgents": "Mostrar todos los agentes",
  "tasks.showLess": "mostrar menos",
  "tasks.moreAgents": "+{count} más",
  "tasks.saveConflict":
    "Esta tarea cambió mientras la editabas, así que tus cambios no se guardaron.",
  "tasks.create": "Crear",
  "tasks.globalShort": "Global",
  "tasks.shownCount": "{count} a la vista",
  "tasks.quickAdd": "Añadir una tarea rápida…",
  "tasks.fileIn": "archivar en",
  "tasks.fileInTitle": "Las tareas nuevas se archivan en esta sala",
  "tasks.hintMobile": "Intro para añadir detalles",
  "tasks.hintDesktop": "Intro para añadir detalles · n para enfocar",
  "tasks.scopeTitle":
    "Filtrar las tareas y elegir dónde se archivan las nuevas",
  "tasks.allRooms": "Todas las salas",
  "tasks.filterAssignee": "Filtrar por responsable...",
  "tasks.filterPriorityNone": "Sin prioridad",
  "tasks.filterAllStatuses": "Todos los estados",
  "tasks.filterAllPriorities": "Todas las prioridades",
  "tasks.filterNone": "Ninguno",
  "tasks.filterPriorityNoneShort": "ninguna",
  "tasks.searchPlaceholder": "Buscar tareas...",
  "tasks.col.status": "E",
  "tasks.col.priority": "P",
  "tasks.col.title": "TÍTULO",
  "tasks.col.assignee": "RESPONSABLE",
  "tasks.col.by": "POR",
  "tasks.col.age": "EDAD",
  "tasks.empty": "No hay tareas",
  "tasks.roomChipTitle": "Sala: {room}",
  "tasks.github.chipTitle": "Abrir la incidencia en GitHub",
  "tasks.github.heading": "Obtenida de GitHub",
  "tasks.github.state.open": "Abierta",
  "tasks.github.state.completed": "Cerrada como completada",
  "tasks.github.state.notPlanned": "Cerrada como no planificada",
  "tasks.github.state.duplicate": "Cerrada como duplicada",
  "tasks.github.syncing": "Se mantiene al día desde GitHub.",
  "tasks.github.notSyncing":
    "Ya no se actualiza: la sala no está enlazada con este repositorio.",
  "tasks.globalChipTitle": "Tarea global de la oficina",
  "tasks.createdFor": "{who} · para {target}",
  "tasks.killedName": "{name} (detenido)",
  "office.newAgent": "Agente nuevo",
  "apps.actionFailed.start": "No se pudo arrancar.",
  "apps.actionFailed.stop": "No se pudo parar.",
  "apps.actionFailed.restart": "No se pudo reiniciar.",
  "apps.section.running": "En marcha",
  "apps.section.stopped": "Paradas",
  "apps.section.archived": "Archivadas",
  "apps.menu.start": "Arrancar",
  "apps.menu.stop": "Parar",
  "apps.menu.restart": "Reiniciar",
  "apps.menu.log": "Ver el registro",
  "apps.menu.archive": "Archivar",
  "apps.menu.unarchive": "Desarchivar",
  "apps.menu.delete": "Eliminar...",
  "apps.menu.install": "Instalar como app",
  "apps.menu.inboxOn": "Permitir que responda mis peticiones",
  "apps.menu.inboxOff": "Impedir que responda mis peticiones",
  "apps.actionFailed.inbox": "No se pudo guardar.",
  "apps.actionFailed.archive": "No se pudo archivar.",
  "apps.actionFailed.unarchive": "No se pudo desarchivar.",
  "common.untitledConversation": "Conversación sin título",
  "schedules.human.daily": "Cada día a las {time}",
  "schedules.human.weekly": "Cada semana, {weekday} a las {time}",
  "schedules.human.everyMinutes": "Cada {minutes}m",
  "schedules.human.everyHours": "Cada {hours}h",
  "schedules.human.everyHoursMinutes": "Cada {hours}h{minutes}m",
  "schedules.human.none": "Bajo demanda",
  "schedules.nextRunIn": "en {duration}",

  "commands.clear.description": "Borrar el historial de la conversación",
  "commands.handoff.description": "Continuar la tarea en una sesión nueva",
  "commands.context.description": "Ver el uso de la ventana de contexto",
  "commands.help.description": "Listar todos los comandos disponibles",
  "commands.resume.description": "Retomar una sesión anterior",
  "commands.login.description": "Ver cómo autenticar (de nuevo) este agente",
  "commands.logout.description": "Gestionar el inicio de sesión o cerrarla",
  "commands.isomuxAllHands.description":
    "Resumen de todos los agentes y sus conversaciones",
  "commands.isomuxSystemPrompt.description":
    "Ver el prompt de sistema completo que recibe este agente",
  "commands.isomuxCronjobSystemPrompt.description":
    "Ver el prompt de sistema que recibe una programación (pasa el nombre o el id)",
  "commands.isomuxDiff.description":
    "Ver los cambios sin confirmar en el cwd del agente (o pasa un directorio)",
  "commands.isomuxEdit.description":
    "Abrir un archivo en el panel lateral del editor (relativo al cwd, absoluto o ~/...)",
  "commands.isomuxUsage.description":
    "Gasto de tokens por agente, por sala y por programación",
  "commands.isomuxStorage.description":
    "Espacio en disco que usa la oficina, desglosado por categoría",
  "commands.compact.description": "Comprimir el contexto",
  "commands.compact.message":
    "`/compact` todavía no está disponible en Isomux. El SDK compacta el contexto automáticamente.",
  "commands.branch.description":
    "Ramificar la conversación en una sesión nueva",
  "commands.export.description": "Exportar la conversación a un archivo",
  "commands.plan.description": "Activar o desactivar el modo de planificación",
  "commands.rename.description": "Renombrar la sesión actual",
  "commands.reset.description": "Reiniciar la conversación",
  "commands.new.description": "Empezar una conversación nueva",
  "commands.model.description": "Cambiar de modelo",
  "commands.fast.description": "Activar o desactivar el modo rápido",
  "commands.effort.description": "Fijar el nivel de esfuerzo de razonamiento",
  "commands.advisor.description": "Activar o desactivar el modo asesor",
  "commands.cost.description": "Uso de tokens y coste estimado",
  "commands.cost.message":
    "`/cost` es un comando de Claude Code para quien usa la API. Isomux factura por suscripción.",
  "commands.usage.description":
    "Dónde consultar el uso de la suscripción y de la oficina",
  "commands.stats.description": "Patrones de uso a lo largo del tiempo",
  "commands.extraUsage.description": "Opciones de uso adicional",
  "commands.rateLimitOptions.description":
    "Configuración del límite de peticiones",
  "commands.rewind.description":
    "Deshacer los cambios y revertir la conversación",
  "commands.copy.description": "Copiar la última respuesta al portapapeles",
  "commands.files.description": "Listar los archivos que hay en el contexto",
  "commands.addDir.description": "Añadir más directorios de trabajo",
  "commands.btw.description": "Preguntar sin ensuciar el contexto principal",
  "commands.config.description": "Abrir la interfaz de ajustes",
  "commands.hooks.description": "Gestionar los hooks del ciclo de vida",
  "commands.permissions.description":
    "Gestionar los permisos de las herramientas",
  "commands.keybindings.description": "Editar los atajos de teclado",
  "commands.memory.description": "Ver o editar la memoria persistente",
  "commands.mcp.description": "Gestionar las conexiones a servidores MCP",
  "commands.ide.description": "Gestionar las integraciones con el IDE",
  "commands.agents.description": "Gestionar los subagentes personalizados",
  "commands.skills.description": "Listar todas las habilidades disponibles",
  "commands.sandbox.description": "Gestionar los ajustes del sandbox",
  "commands.privacySettings.description": "Gestionar los ajustes de privacidad",
  "commands.theme.description": "Cambiar el tema de color",
  "commands.vim.description": "Activar o desactivar los atajos de vim",
  "commands.terminalSetup.description":
    "Configurar la integración con el terminal",
  "commands.reloadPlugins.description":
    "Recargar los plugins y la configuración",
  "commands.reloadPlugins.reloaded": "Plugins recargados.",
  "commands.reloadPlugins.reloadedToolsChanged":
    "Plugins recargados. Las herramientas del agente cambiaron, así que su próximo turno cuesta más.",
  "commands.reloadPlugins.errors": "Errores de plugins: {count}",
  "commands.reloadPlugins.busy":
    "Los plugins no se pueden recargar durante un turno. Envía `/reload-plugins` de nuevo cuando termine.",
  "commands.reloadPlugins.nextMessage":
    "Lista de habilidades y comandos actualizada. Los plugins se vuelven a cargar con el próximo mensaje.",
  "commands.reloadPlugins.menuRefreshed":
    "Lista de habilidades y comandos actualizada.",
  "commands.reloadPlugins.done":
    "Los plugins y la configuración se recargan en el próximo turno.",
  "commands.reloadPlugins.pending":
    "Los plugins y la configuración se recargan cuando no haya ningún turno de OpenCode en curso.",
  "commands.reloadPlugins.failed":
    "Los plugins y la configuración no se recargaron: {error}",
  "commands.tasks.description":
    "Listar o gestionar las tareas en segundo plano",
  "commands.doctor.description": "Comprobar el estado de la instalación",
  "commands.feedback.description": "Informar de errores a Anthropic",
  "commands.releaseNotes.description": "Ver las notas de la versión",
  "commands.heapdump.description": "Volcar el heap para depurar",
  "commands.status.description": "Ver el estado del sistema",
  "commands.tag.description": "Etiquetar la conversación actual",
  "commands.init.description": "Inicializar Claude Code en un proyecto",
  "commands.installGithubApp.description":
    "Configurar la app de revisión de PR de Claude en GitHub",
  "commands.prComments.description": "Ver los comentarios del PR",
  "commands.desktop.description": "Abrir la app de escritorio",
  "commands.mobile.description": "Abrir la app móvil",
  "commands.chrome.description": "Abrir la extensión de Chrome",
  "commands.session.description": "Gestionar las sesiones",
  "commands.teleport.description": "Transferir la sesión a otro dispositivo",
  "commands.remoteEnv.description": "Configurar el entorno remoto",
  "commands.exit.description": "Salir de Claude Code",
  "commands.exit.message":
    "Usa la interfaz de Isomux para gestionar los agentes. `/exit` solo funciona en la CLI de Claude Code.",
  "commands.stickers.description": "Pegatinas divertidas",
  "commands.upgrade.description": "Actualizar Claude Code",
  "commands.plugin.description": "Gestionar los plugins",
  "commands.plugin.message":
    "Gestionar plugins requiere la CLI de Claude Code directamente.\n\nPara gestionar los plugins:\n1. Abre el terminal integrado (haz clic en el icono de terminal del escritorio del agente)\n2. Ejecuta `claude`\n3. Escribe `/plugin` para explorar, instalar, activar o desactivar plugins\n\nComandos útiles:\n- `/plugin` - gestor interactivo de plugins (explorar, instalar, activar/desactivar)\n- `{addCommand}` - instalar un plugin por su nombre\n- `/plugin marketplace add owner/repo` - añadir un marketplace de la comunidad\n\nDespués de instalar un plugin, envía `/reload-plugins` al agente.",
  "commands.batch.description": "Descomponer en agentes paralelos con worktree",
  "commands.claudeApi.description":
    "Cargar la referencia de la API o el SDK del lenguaje detectado",
  "commands.claudeInChrome.description":
    "Automatizar interacciones con el navegador Chrome",
  "commands.debug.description":
    "Diagnosticar problemas de sesión o de herramientas desde el log de depuración",
  "commands.keybindingsHelp.description": "Personalizar los atajos de teclado",
  "commands.loop.description": "Ejecutar un prompt de forma periódica",
  "commands.loop.message":
    "no está disponible de forma nativa; mira si la página de Automatizaciones o los mensajes programados te sirven",
  "commands.loremIpsum.description": "Generar texto de relleno",
  "commands.codeReview.description":
    "Revisa en busca de errores los cambios actuales, un PR, una rama o una ruta (nivel de esfuerzo, --fix, --comment, --max-findings)",
  "commands.review.description":
    "Revisión de código en busca de errores, lógica y casos límite",
  "commands.schedule.description": "Crear agentes remotos programados con cron",
  "commands.securityReview.description":
    "Revisión de código centrada en la seguridad",
  "commands.simplify.description":
    "Limpieza de código y análisis de reutilización",
  "commands.skillify.description":
    "Capturar procesos como habilidades reutilizables",
  "commands.stuck.description": "Diagnosticar sesiones bloqueadas o lentas",
  "commands.ultrareview.description": "Revisión de PR ultraexhaustiva",
  "commands.updateConfig.description": "Configurar settings.json",
  "commands.unsupported.hardcoded":
    "`/{name}` ({description}) es un comando de Claude Code, pero no está disponible en Isomux.",
  "commands.unsupported.bundledSkill":
    "`/{name}` ({description}) es una habilidad incluida en Claude Code, pero no está disponible en Isomux. Puedes sustituirla creando tu propio archivo de habilidad.",
  "commands.native.attachments":
    "`/{name}` no admite archivos adjuntos. Envía los archivos en otro mensaje.",
  "commands.unsupported.engine":
    "`/{name}` solo funciona en agentes de {engines}.",
  "commands.unsupported.notAvailable":
    "`/{name}` no está disponible en Isomux.",
  "commands.unsupported.unknownCommand":
    "Comando desconocido `/{name}`. Escribe `/help` para ver los comandos disponibles.",
  "commands.clear.failed": "No se pudo borrar la conversación: {error}",
  "commands.handoff.waiting": "Se traspasa cuando termine este turno.",
  "commands.handoff.underWay": "Ya hay un traspaso en curso.",
  "commands.handoff.empty":
    "No hay nada que traspasar: esta conversación está vacía.",
  "commands.handoff.notResumable":
    "No se puede traspasar: esta conversación no se puede reanudar. Escribe /clear para empezar de cero.",
  "commands.context.header": "**{model}** - {used} / {max} tokens ({percent}%)",
  "commands.context.noSession": "No hay ninguna sesión activa.",
  "commands.context.unavailable":
    "El uso de contexto no está disponible en esta sesión.",
  "commands.context.staleUnavailable":
    "No hay medición en vivo. Se muestra la última lectura registrada, tomada {age}.",
  "commands.context.staleFailed":
    "La medición en vivo ha fallado. Se muestra la última lectura registrada, tomada {age}.",
  "commands.context.ageUnderMinute": "hace menos de un minuto",
  "commands.context.ageMinutes": "hace {minutes}m",
  "commands.context.ageHoursMinutes": "hace {hours}h {minutes}m",
  "commands.context.category": "{name}: {tokens} tokens ({percent}%)",
  "commands.context.memoryFiles": "**Archivos de memoria:**",
  "commands.context.memoryFile": "{path} ({tokens} tokens)",
  "commands.context.systemPrompt": "**Prompt de sistema:**",
  "commands.context.systemPromptSection": "{name}: {tokens} tokens",
  "commands.context.autoCompact":
    "Compactación automática al {percent}% ({tokens} tokens)",
  "commands.context.failed": "No se pudo obtener el uso de contexto: {error}",
  "commands.help.docs": "**Documentación:** {url}",
  "commands.help.skills": "**Habilidades:** [página de Habilidades]({url})",
  "commands.help.header": "**Ayuda**",
  "commands.help.commands": "## Comandos que puedes escribir",
  "commands.help.receptionist":
    "Si tienes preguntas sobre funciones de Isomux, como vincular otros dispositivos, invitar a otras personas a tu oficina, cómo se comunican los agentes entre sí o cómo conectar tus proveedores de LLM, pregunta al agente Recepcionista.",
  "commands.help.aliasGroup": "{primary} (o {others})",
  "commands.resume.none": "No hay sesiones anteriores.",
  "commands.resume.header": "Retoma una conversación anterior:",
  "commands.resume.noOthers": "No hay otras sesiones que retomar.",
  "commands.resume.branched": "(ramificada)",
  "commands.plan.on":
    "El modo de planificación está activado. Envía /plan de nuevo para desactivarlo.",
  "commands.plan.off": "El modo de planificación está desactivado.",
  "commands.plan.unavailable":
    "El modo de planificación no está disponible para los agentes de {engine}.",
  "commands.model.openCodeUnsupported":
    "Abre los ajustes del agente para elegir un modelo de OpenCode conectado.",
  "commands.model.header": "Cambiar de modelo (actual: **{current}**):",
  "commands.effort.openCodeSettings":
    "Las opciones de esfuerzo de OpenCode están disponibles en los ajustes del agente para los modelos que las ofrecen.",
  "commands.effort.unsupported": "{model} no admite niveles de esfuerzo.",
  "commands.effort.header":
    "Cambiar el esfuerzo de razonamiento (actual: **{current}**):",
  "commands.isomuxAllHands.room": "**=== Sala {number} ===**",
  "commands.isomuxAllHands.me": "**(yo)**",
  "commands.isomuxAllHands.desk": "escritorio {number}",
  "commands.isomuxAllHands.topic": "Tema: {topic}",
  "commands.isomuxAllHands.backRoom": "{count} en la trastienda",
  "commands.isomuxAllHands.footer":
    "Pregunta a tu agente si quieres saber más sobre cualquier agente o conversación.",
  "commands.isomuxSystemPrompt.header":
    "**Prompt de sistema completo** *(refleja los ajustes actuales; se aplica en la próxima conversación)*",
  "commands.isomuxCronjobSystemPrompt.noSchedules":
    "No hay ninguna programación configurada.",
  "commands.isomuxCronjobSystemPrompt.pick": "Elige una programación:",
  "commands.isomuxCronjobSystemPrompt.ambiguous":
    'Hay varias programaciones que se llaman "{query}". Vuelve a ejecutarlo con el id:',
  "commands.isomuxCronjobSystemPrompt.noMatch":
    "Ninguna programación coincide con `{query}`. Prueba `/isomux-cronjob-system-prompt` sin argumentos para listarlas.",
  "commands.isomuxCronjobSystemPrompt.header":
    '**Prompt de sistema y primer mensaje de usuario de la programación "{name}"** *(refleja los ajustes actuales; se aplica en la próxima ejecución)*',
  "commands.isomuxCronjobSystemPrompt.firstUserMessage":
    "Primer mensaje de usuario:",
  "commands.isomuxEdit.usage":
    "Uso: {usage}. La ruta puede ser relativa (se resuelve desde {cwd}), absoluta o `~/...`.",
  "commands.isomuxEdit.emptyPath": "Ruta vacía.",
  "systemEntries.pathRefusal.notFound": "`{path}` no existe.",
  "systemEntries.pathRefusal.notFile": "`{path}` no es un archivo.",
  "systemEntries.pathRefusal.binary":
    "`{path}` es un archivo binario: el panel del editor solo admite texto.",
  "systemEntries.pathRefusal.tooLarge":
    "`{path}` ocupa {size}, demasiado para el panel del editor (el límite es 1 MB).",
  "systemEntries.pathRefusal.credential":
    "`{path}` contiene credenciales, así que no se abre en el panel del editor.",
  "commands.isomuxDiff.notDirectory": "`{path}` no es un directorio.",
  "systemEntries.diffNotRepo": "`{path}` no es un repositorio de git.",
  "commands.usage.meter":
    "Consulta el medidor de uso en la cabecera del chat para ver los límites de la suscripción y cuándo se restablecen.",
  "commands.usage.unavailable":
    "Este agente no informa del uso de la suscripción.",
  "commands.usage.office":
    "Para el gasto de tokens de la oficina (por agente, por sala y por programación), mira `/isomux-usage`.",
  "commands.isomuxStorage.forbidden":
    "El uso de disco solo está disponible para miembros de la oficina que hayan iniciado sesión.",
  "commands.skill.queueFailed": "No se pudo encolar {command}: {error}",
  "commands.skill.error": "Error de la habilidad: {error}",
  "choices.resume.title": "Retomar una conversación",
  "choices.resume.instruction":
    "Responde con un número para retomarla, o cualquier otra cosa para cancelar.",
  "choices.resume.branched": "Ramificada",
  "choices.model.title": "Cambiar de modelo",
  "choices.model.instruction":
    "Responde con un número para cambiar, o cualquier otra cosa para cancelar.",
  "choices.effort.title": "Cambiar el esfuerzo de razonamiento",
  "choices.cronjob.title": "Elegir una programación",
  "choices.cronjob.instruction":
    "Responde con un número para ver su prompt o con cualquier otra cosa para cancelar.",
  "choices.permission.title": "Quiere usar {tool}",
  "choices.permission.instruction":
    "Elige una opción, o escribe cualquier otro mensaje para denegar con ese motivo.",
  "choices.permission.reply": "Responde:",
  "choices.permission.allowOnce": "Permitir solo esta vez",
  "choices.permission.deny": "Denegar",
  "choices.permission.allowPrefix":
    "Permitir y no volver a preguntar en esta sesión por ningún comando que empiece por `{prefix}`",
  "choices.permission.prefixHint":
    "Responde `{replySpec}` para elegir cuánto permites, por ejemplo `{index} {example}`.",
  "choices.permission.denyByMessage":
    "O escribe cualquier otro mensaje para denegar con ese motivo.",
  "systemEntries.newConversation": "Conversación nueva iniciada.",
  "systemEntries.handedOff": "Traspasado a una sesión nueva.",
  "systemEntries.handoff.failed":
    "El traspaso no se completó. Esta conversación continúa.",
  "systemEntries.handoff.canceled": "Traspaso cancelado.",
  "systemEntries.managerChanged":
    "{actor} hizo responsable a {member}. Conversación nueva iniciada.",
  "systemEntries.autoHandoff.writingTokens":
    "El contexto está en {thousands}k tokens. Escribiendo un resumen de traspaso para una sesión nueva.",
  "systemEntries.autoHandoff.writingPercent":
    "El contexto está al {percent}%. Escribiendo un resumen de traspaso para una sesión nueva.",
  "systemEntries.autoHandoff.writingCompaction":
    "El contexto está al {percent}%, cerca de la compactación automática. Escribiendo un resumen de traspaso para una sesión nueva.",
  "systemEntries.autoHandoff.doneTokens":
    "Traspasado automáticamente a {thousands}k tokens.",
  "systemEntries.autoHandoff.donePercent":
    "Traspasado automáticamente con el contexto al {percent}%.",
  "systemEntries.autoHandoff.doneCompaction":
    "Traspasado automáticamente con el contexto al {percent}%, antes de la compactación automática.",
  "systemEntries.autoHandoff.failed":
    "El traspaso automático no se completó. Esta conversación continúa.",
  "systemEntries.autoHandoff.retry":
    "El traspaso automático no se completó. Isomux lo intenta de nuevo tras la próxima respuesta del agente.",
  "systemEntries.autoHandoff.paused":
    "El traspaso automático está en pausa en esta conversación: empezó por encima del umbral de traspaso.",
  "systemEntries.limitResume.resumed":
    "El límite de uso se restableció. Isomux reanudó el agente.",
  "systemEntries.usageLimit.stopped":
    "Se alcanzó el límite de uso. Se reinicia el {at} ({relative}).",
  "systemEntries.usageCap.pace":
    "Los turnos de los miembros están en pausa: el uso de la oficina ha llegado al límite de hoy para los miembros. Se reanudan {when}.",
  "systemEntries.usageCap.headsUp":
    "El uso de la oficina está cerca del límite de hoy para los miembros. Los turnos de los miembros se pausan cuando se alcanza.",
  "systemEntries.agentStopped": "El agente se detuvo: {status}.",
  "systemEntries.backendFailure.stoppedDuringTurn":
    "El backend del agente se detuvo durante el turno. La conversación está guardada y se puede retomar.",
  "systemEntries.backendFailure.sigterm":
    "El backend del agente se terminó con SIGTERM (código de salida {code}). La causa más probable es la protección contra falta de memoria de esta máquina. La conversación está guardada y se puede retomar.",
  "systemEntries.backendFailure.sigkill":
    "El backend del agente se mató con SIGKILL (código de salida {code}). La causa más probable es la protección contra falta de memoria de esta máquina. La conversación está guardada y se puede retomar.",
  "systemEntries.backendFailure.serverStopped":
    "El backend del agente se detuvo porque el servidor de Isomux se estaba apagando o reiniciando (código de salida {code}). La conversación está guardada y se puede retomar.",
  "systemEntries.backendFailure.signal":
    "El backend del agente se detuvo con la señal {signal} (código de salida {code}). La conversación está guardada y se puede retomar.",
  "systemEntries.backendFailure.providerCapacity":
    "El proveedor del modelo está saturado. Es un problema del lado del proveedor, no de la suscripción ni de los límites de uso de esta cuenta. Reintenta en un minuto o elige otro modelo. La conversación está guardada y se puede retomar.",
  "systemEntries.providerCapacityRetry":
    "El proveedor del modelo está saturado. Se reintentará en {seconds} segundos ({attempt}/{maxAttempts}).",
  "systemEntries.agentReady":
    'El agente "{name}" está listo. Trabaja en {cwd}. Modo de permisos: {mode}.',
  "systemEntries.streamError": "Error de flujo: {error}",
  "systemEntries.startFailed": "No se pudo iniciar: {error}",
  "systemEntries.interrupted": "Agente interrumpido.",
  "systemEntries.wake.idle":
    "Se retomó tu sesión (se había liberado por inactividad para ahorrar memoria).",
  "systemEntries.wake.env":
    "Se retomó tu sesión con los secretos y las variables actuales.",
  "systemEntries.wake.afterRestart":
    "Se retomó tu sesión después de reiniciar el servidor.",
  "systemEntries.wake.afterBackendEnded":
    "Se retomó tu sesión después de que el backend terminara de forma inesperada.",
  "systemEntries.wake.inFlightWarning":
    "Puede que algún comando en curso se ejecutara a medias; comprueba sus efectos antes de reintentar.",
  "systemEntries.wake.shutdownRejection":
    'El resultado "user rejected" de aquí arriba viene del apagado, no de una persona.',
  "systemEntries.wake.resumedBeforeFlush":
    "Se retomó la sesión anterior antes de vaciar la cola de mensajes.",
  "systemEntries.wake.resumedAfterUnexpectedEnd":
    "Se retomó la sesión anterior después de que la última terminara de forma inesperada.",
  "systemEntries.codexInterruptExited":
    "Codex se cerró durante la interrupción; se instala una sesión nueva.",
  "systemEntries.codexInterruptExitedWithError":
    "Codex se cerró durante la interrupción: {error}",
  "systemEntries.previousInterrupted": "La respuesta anterior se interrumpió.",
  "systemEntries.interruptedPermissionDenied":
    "Agente interrumpido; la petición de permiso pendiente se denegó.",
  "systemEntries.interruptedPermissionRestarted":
    "Agente interrumpido; la petición de permiso pendiente no se pudo denegar, así que se reinició el backend del agente; la conversación se conserva.",
  "systemEntries.interruptHandlerFailed":
    "Falló el gestor de interrupciones: {error}",
  "systemEntries.codexSandboxUnavailable":
    "Este contenedor no puede ejecutar el sandbox de Codex, así que los comandos se ejecutan con acceso completo dentro del contenedor.",
  "systemEntries.providerRefused":
    'El proveedor `{provider}` rechazó la solicitud: "{message}"',
  "systemEntries.openCodeFreeTierHint":
    "OpenCode también puede enviar esto cuando un servidor usa demasiado su nivel gratuito. Un modelo de pago u OpenCode Go lo evita.",
  "systemEntries.openCodeProviderRetry":
    'El proveedor `{provider}` informó: "{message}"; reintento {attempt} de {maxAttempts}.',
  "systemEntries.openCodePreviousSettings":
    "Este turno usa tus claves de API anteriores.",
  "systemEntries.codexInterruptFallback":
    "Codex no atendió la interrupción a tiempo; se pasa a una sesión nueva.",
  "systemEntries.deliveryStalled":
    "La entrega del mensaje se ha atascado; recuperando.",
  "systemEntries.freshSessionAfterRestoreFailure":
    "Se inició una sesión nueva (la anterior no se pudo restaurar).",
  "systemEntries.sessionNotResumable":
    "Se inició una sesión nueva (la anterior ya no está guardada).",
  "systemEntries.freshSessionBeforeFlush":
    "Se inició una sesión nueva antes de vaciar la cola de mensajes.",
  "systemEntries.flushStartFailed":
    "No se pudo iniciar la sesión para vaciar la cola: {error}\nEscribe /clear para empezar de cero, o /resume para elegir otra sesión.",
  "systemEntries.restartingForSettings":
    "Se reinicia la sesión para aplicar los ajustes; los mensajes en cola saldrán después del reinicio.",
  "systemEntries.settingsNotice.changed":
    "{names} cambió tus ajustes y tu sesión se reinició.",
  "systemEntries.settingsNotice.change": "{setting}: {from} → {to}",
  "systemEntries.settingsNotice.interrupted":
    "El reinicio detuvo tu turno anterior.",
  "systemEntries.flushError": "Error al vaciar la cola: {error}",
  "systemEntries.genericError": "Error: {error}",
  "systemEntries.restoreOnStartupFailed":
    "No se pudo restaurar al arrancar: {error}\nEscribe /clear para empezar de cero, o /resume para elegir otra sesión.",
  "systemEntries.flushInterrupted":
    "El vaciado de la cola se interrumpió por un cambio de sesión; se reintentará.",
  "systemEntries.sessionStartFailed":
    "No se pudo iniciar la sesión: {error}\nEscribe /clear para empezar de cero, o /resume para elegir otra sesión.",
  "systemEntries.queueFailed": "No se pudo encolar el mensaje: {error}",
  "systemEntries.queueKept.notConfigured.one":
    "Se conservó {count} mensaje en cola. Se envía con el próximo mensaje.",
  "systemEntries.queueKept.notConfigured.other":
    "Se conservaron {count} mensajes en cola. Se envían con el próximo mensaje.",
  "systemEntries.queueCarried.one":
    "Se movió {count} mensaje en cola a esta conversación.",
  "systemEntries.queueCarried.other":
    "Se movieron {count} mensajes en cola a esta conversación.",
  "systemEntries.contextCompacted": "Contexto compactado: {summary}",
  "systemEntries.contextCompactedNoSummary": "Contexto compactado.",
  "systemEntries.toolCallDenied": "Llamada a herramienta denegada: {tool}",
  "systemEntries.toolCallDeniedWithReason":
    "Llamada a herramienta denegada: {tool} ({reason})",
  "systemEntries.inputRequest":
    "El backend pidió una entrada interactiva que Isomux no puede mostrar de forma segura.",
  "systemEntries.permissionRequested":
    "Permiso solicitado para {tool}. Entrada: {input}.",
  "systemEntries.diffEmptyCommit":
    "`{commit}` no introdujo cambios en ningún archivo (¿commit vacío?).",
  "systemEntries.permissionOutcome.allowPersistent":
    "Permitir llamadas similares en esta sesión",
  "systemEntries.permissionOutcome.allowPrefix":
    "Permitir un prefijo de comando en esta sesión",
  "systemEntries.permissionOutcome.denyWithReason": "Denegar con un motivo",
  "systemEntries.permissionOutcome.denyWhenStopped": "Denegar al detenerse",
  "systemEntries.permissionOutcome.sessionChanged":
    "Cancelado al cambiar de sesión",
  "systemEntries.permissionOutcome.priorSessionStopped":
    "Cancelado mientras se detenía la sesión anterior",
  "systemEntries.permissionOutcome.sessionEnded":
    "Cancelado porque la sesión terminó",
  "systemEntries.permissionOutcome.agentKilled":
    "Cancelado al eliminar el agente",
  "systemEntries.permissionOutcome.failed": "No se pudo resolver",
  "systemEntries.permissionChoice": "Permiso elegido: {label}.",
  "systemEntries.permissionGrantedOnce": "Permiso concedido (solo esta vez).",
  "systemEntries.permissionGrantedPersistent":
    "Permiso concedido (regla añadida para esta sesión).",
  "systemEntries.permissionDenied": "Permiso denegado.",
  "systemEntries.permissionDeniedWithReason":
    "Permiso denegado; el motivo se ha enviado al agente.",
  "systemEntries.permissionSessionGone":
    "El permiso no se pudo resolver: la sesión ya no existe.",
  "systemEntries.permissionResolveFailed":
    "No se pudo resolver el permiso: {error}",
  "systemEntries.resumedSession": "Sesión retomada: {label}",
  "systemEntries.sessionPreviousManager":
    "Esta sesión todavía tiene a {name} como responsable y usa sus conexiones.",
  "systemEntries.resumeFailed":
    "No se pudo retomar: {error}\nEscribe /clear para empezar de cero, o /resume para elegir otra sesión.",
  "systemEntries.resumeCancelled": "Retomada cancelada.",
  "systemEntries.resumeCwdUnavailable":
    "El directorio guardado de la sesión `{stored}` no está disponible ({error}); se retoma en `{previous}`.",
  "systemEntries.alreadyUsing": "Ya está usando {label}.",
  "systemEntries.modelSwitched":
    "Modelo cambiado a {label}. El contexto del agente puede seguir diciendo que es otro modelo; el correcto es el de la barra superior.",
  "systemEntries.modelCancelled": "Cambio de modelo cancelado.",
  "systemEntries.effortSwitched":
    "Esfuerzo de razonamiento cambiado a {label}.",
  "systemEntries.effortCancelled": "Cambio de esfuerzo cancelado.",
  "systemEntries.cronjobPickCancelled": "Selección de programación cancelada.",
  "systemEntries.branchedFrom": "Ramificada a partir de: {label}",
  "systemEntries.branchFailed": "No se pudo ramificar la conversación: {error}",
  "systemEntries.editBusy": "No se puede editar mientras el agente trabaja.",
  "systemEntries.editNotFound":
    "No se puede editar: no se encuentra el mensaje.",
  "systemEntries.editNoSession":
    "No se puede editar: no hay ninguna sesión activa.",
  "systemEntries.editPendingInteraction":
    "No se puede editar este prompt mientras hay un comando interactivo pendiente. Respóndelo o cancélalo primero.",
  "systemEntries.editNotSent":
    "No se puede editar: este mensaje no llegó al agente y después hubo mensajes más nuevos. Envía uno nuevo.",
  "systemEntries.editNotLocated":
    "No se puede editar: no se encuentra el mensaje en la sesión del backend.",
  "systemEntries.editOtherSession":
    'Este mensaje está en otra sesión ("{label}"). Usa /resume para cambiar a ella y edítalo después.',
  "systemEntries.cwdMoveBackFailed":
    "Aviso: tras el fallo al cambiar de cwd, los archivos de sesión no se pudieron devolver a {previous} y ahora están en {target}; retomarla puede fallar hasta que se restauren.",
  "systemEntries.fileOpenFailed": "No se pudo abrir `{path}`: {message}",
  "systemEntries.fileReadFailed": "No se pudo leer `{path}`: {message}",
  "systemEntries.fileTooLargeToDisplay":
    "`{path}` ocupa {size}: demasiado grande para mostrarlo (límite de {limit} MB).",
  "systemEntries.fileSaveFailed": "No se pudo guardar `{path}` para mostrarlo.",
  "systemEntries.diffFailed": "No se pudo ejecutar git diff en `{path}`:",
  "systemEntries.diffBadDir": "No se puede hacer diff de `{path}`: {message}.",
  "systemEntries.diffClean":
    "El árbol de trabajo de `{path}` está limpio: no hay cambios sin confirmar.",
  "systemEntries.claudeAuth.checking":
    "Claude rechazó las credenciales. Comprobando la conexión…",
  "systemEntries.claudeAuth.officeLocation":
    "Integraciones → Proveedores de modelos (De toda la oficina)",
  "systemEntries.claudeAuth.personalLocation":
    "Integraciones → Proveedores de modelos (Personales)",
  "systemEntries.claudeAuth.disconnected":
    "Claude rechazó las credenciales. Inicia sesión en Claude en {location}.",
  "systemEntries.claudeAuth.disconnectedAskOwner":
    "Claude rechazó las credenciales. Pide a un propietario de la oficina que inicie sesión.",
  "systemEntries.claudeAuth.signingIn":
    "Claude rechazó las credenciales. Hay un inicio de sesión de Claude en curso. Reintenta la solicitud cuando termine.",
  "systemEntries.claudeAuth.accessUnavailable":
    "El acceso a Claude Code no está disponible para esta cuenta. Revisa su suscripción o inicia sesión con otra cuenta.",
  "systemEntries.claudeAuth.pinned":
    "Esta conversación conserva la cuenta de Claude con la que se inició. Inicia una conversación nueva (`/clear`) para usar la cuenta nueva.",
  "systemEntries.claudeSession.invalid":
    "No se puede acceder a esta conversación de Claude.",
  "systemEntries.claudeSession.missing":
    "No se puede reanudar la sesión de Claude {session}…: no se encontró su archivo. Rutas comprobadas: {paths}.",
  "systemEntries.loginInstructions.generic":
    "Para autenticarte:\n1. Abre la terminal integrada\n2. Ejecuta `claude`\n3. Escribe `/login`\n4. Sigue el proceso de autenticación\n\nAl terminar, se aplica de inmediato a todos los agentes de Isomux.",
  "systemEntries.loginInstructions.claude":
    "Para autenticar Claude Code:\n1. Abre la terminal integrada\n2. Ejecuta `{command}`\n3. Escribe `/login`\n4. Sigue el proceso de autenticación\n\nAl terminar, se aplica de inmediato a todos los agentes de Isomux.\n\nAlternativa: añade `ANTHROPIC_API_KEY` en la página Integraciones (pestaña Variables) y luego usa `/clear`.",
  "systemEntries.loginInstructions.claudeSignedIn":
    "Claude Code tiene la sesión iniciada. Escribe `/clear` para renovar la sesión de este agente y aplicar la nueva autenticación.",
  "systemEntries.loginInstructions.codex":
    "Para iniciar sesión en Codex, haz clic en [Copiar en la terminal] en la tarjeta de abajo:\n\n- `{command} login --device-auth`\n\nPulsa Intro para ejecutarlo, sigue las indicaciones y luego usa `/clear` en esta conversación para aplicar la nueva autenticación. Los demás agentes de Codex la aplican en su próximo `/clear`.\n\nAlternativa: añade `OPENAI_API_KEY` en la página Integraciones (pestaña Variables) y luego usa `/clear`.",
  "systemEntries.loginInstructions.codexSignedIn":
    "Codex tiene la sesión iniciada. Escribe `/clear` para renovar la sesión de este agente y aplicar la nueva autenticación.",
  "systemEntries.loginInstructions.codexKeyRejected":
    "Codex rechazó `OPENAI_API_KEY`. Corrige o elimina esa clave en la página Integraciones y luego usa `/clear`.",
  "systemEntries.loginInstructions.openCode":
    "Añade `OPENCODE_API_KEY` en la página Integraciones (pestaña Variables) y luego usa `/clear`, o usa un agente con el motor Claude o Codex.",
  "systemEntries.codexTokenRefresh":
    "Codex pidió renovar su inicio de sesión de ChatGPT, y Isomux no puede hacerlo.",
  "systemEntries.codexSession.missing":
    "No se puede reanudar el hilo de Codex {thread}…: no se encontró ningún archivo de rollout en {dir}. Suele pasar cuando el hilo se inició, pero su proceso terminó antes de recibir un turno del usuario.",
  "systemEntries.openCodeSession.empty":
    "No se puede reanudar la sesión de OpenCode {session}: no tiene mensajes guardados.",
  "systemEntries.openCodeSession.missing":
    "No se puede reanudar la sesión de OpenCode {session}: no está en el perfil de OpenCode seleccionado.",
  "systemEntries.claudeExit.cwdMissing":
    "Causa probable: el cwd `{cwd}` ya no existe. Haz clic en el nombre del agente en la cabecera de la vista del registro para apuntarlo a un directorio válido.",
  "systemEntries.cwdInvalid.missing":
    "El cwd no es válido: el directorio no existe: {path}. Haz clic en el nombre del agente en la cabecera de la vista del registro para corregirlo.",
  "systemEntries.cwdInvalid.notDirectory":
    "El cwd no es válido: no es un directorio: {path}. Haz clic en el nombre del agente en la cabecera de la vista del registro para corregirlo.",
  "systemEntries.cwdInvalid.inaccessible":
    "El cwd no es válido: no se puede acceder a {path}: {message}. Haz clic en el nombre del agente en la cabecera de la vista del registro para corregirlo.",
  "systemEntries.scheduleRun.resumeSkipped":
    "No se puede retomar una ejecución omitida: nunca abrió una sesión.",
  "systemEntries.scheduleRun.resumeNoInit":
    "No se puede retomar: la ejecución original nunca llegó a iniciar el motor.",
  "systemEntries.scheduleRun.resumeCwd.missing":
    "No se puede retomar: la carpeta {path} no existe.",
  "systemEntries.scheduleRun.resumeCwd.notDirectory":
    "No se puede retomar: {path} no es una carpeta.",
  "systemEntries.scheduleRun.resumeCwd.inaccessible":
    "No se puede retomar: sin acceso a la carpeta {path} ({message}).",
  "systemEntries.scheduleRun.envFailed":
    "No se pudieron cargar las variables y los secretos de la página Integraciones: {error}",
  "systemEntries.scheduleRun.openCodeJobDeleted":
    "No se puede retomar esta ejecución de OpenCode porque su programación se eliminó y ya no se puede resolver su perfil de entorno compartido.",
  "systemEntries.scheduleRun.jobDeleted":
    "Ejecución detenida: se eliminó la programación.",
  "systemEntries.scheduleRun.sendFailed": "No se pudo enviar: {error}",
  "systemEntries.scheduleRun.editBusy":
    "No se puede editar mientras la ejecución está ocupada.",
  "systemEntries.scheduleRun.editSkipped":
    "No se puede editar una ejecución omitida: nunca abrió una sesión.",
  "systemEntries.scheduleRun.editNoInit":
    "No se puede editar: la ejecución original nunca llegó a iniciar el motor.",
  "systemEntries.scheduleRun.editCwd.missing":
    "No se puede editar: la carpeta {path} no existe.",
  "systemEntries.scheduleRun.editCwd.notDirectory":
    "No se puede editar: {path} no es una carpeta.",
  "systemEntries.scheduleRun.editCwd.inaccessible":
    "No se puede editar: sin acceso a la carpeta {path} ({message}).",
  "systemEntries.scheduleRun.editFailed": "No se puede editar: {error}",
  "systemEntries.scheduleRun.editMessageNotFound":
    "No se puede editar: no se encontró el mensaje.",
  "systemEntries.scheduleRun.loadMessagesFailed":
    "No se pudieron cargar los mensajes de la sesión: {error}",
  "systemEntries.scheduleRun.editMessageNotInSession":
    "No se puede editar: no se encontró el mensaje en la sesión del motor.",
  "systemEntries.scheduleRun.editNoFork":
    "No se puede editar: el motor devolvió una sesión nueva (sin rama vinculada).",
  "systemEntries.scheduleRun.forkFailed": "No se pudo ramificar: {error}",
  "systemEntries.scheduleRun.signIn":
    "Corrige el inicio de sesión o la clave de API de {provider} en la página Integraciones. La próxima ejecución lo usará.",
  "systemEntries.scheduleRun.signInOpenCode":
    "Añade `OPENCODE_API_KEY` en la página Integraciones (pestaña Variables). La próxima ejecución la usará.",
  "systemEntries.scheduleRun.forkStartFailed":
    "No se pudo iniciar la conversación ramificada: {error}",
  "systemEntries.claudeSession.missingAfterExit":
    "No se puede reanudar la sesión de Claude {session}…: no se encontró su archivo. Rutas comprobadas: {paths}. Usa /resume para seleccionar otra conversación o inicia una conversación nueva.",
  "systemEntries.scheduleRun.resumeFailed": "No se pudo retomar: {error}",
  "systemEntries.contextFull":
    "El contexto está al {percent}%. Considera empezar a cerrar. Puedes usar /clear (para una sesión nueva) o /handoff (para continuar esta con contexto nuevo).",
  "systemEntries.scheduleRun.permissionRequested":
    "La ejecución falló: el agente pidió permiso para usar una herramienta y una ejecución programada no puede responder.",
  "systemEntries.scheduleRun.questionRequested":
    "La ejecución falló: el agente hizo una pregunta y una ejecución programada no puede responder.",
  "systemEntries.scheduleRun.interrupted": "Ejecución interrumpida.",
  "systemEntries.scheduleRun.failed": "La ejecución falló.",
  "systemEntries.scheduleRun.streamEnded":
    "La ejecución falló: la sesión terminó antes de acabar el turno.",
  "systemEntries.scheduleRun.timedOut":
    "Ejecución detenida: duró más de {minutes} minutos.",
  "systemEntries.scheduleRun.skippedInFlight":
    "Omitida: la ejecución anterior de esta programación seguía en curso.",
  "systemEntries.scheduleRun.serverRestarted":
    "Ejecución detenida: el servidor de Isomux se reinició.",
  "systemEntries.scheduleRun.sessionFailed":
    "No se puede iniciar la sesión: {error}",
  "systemEntries.scheduleRun.startCwd.missing":
    "No se puede iniciar: la carpeta {path} no existe.",
  "systemEntries.scheduleRun.startCwd.notDirectory":
    "No se puede iniciar: {path} no es una carpeta.",
  "systemEntries.scheduleRun.startCwd.inaccessible":
    "No se puede iniciar: sin acceso a la carpeta {path} ({message}).",
  "systemEntries.scheduleRun.limit.modeBypass":
    "Esta programación solo se ejecuta mientras {agent}, el agente que la creó, está en el modo Omitir permisos, porque una programación se ejecuta sin nadie presente. Pon {agent} en ese modo, o elimina la programación y vuelve a crearla tú.",
  "systemEntries.scheduleRun.limit.modeCodexFull":
    "Esta programación solo se ejecuta mientras {agent}, el agente que la creó, está en No preguntar nunca con acceso total (sin sandbox), porque una programación se ejecuta sin nadie presente. Da ese acceso a {agent}, o elimina la programación y vuelve a crearla tú.",
  "systemEntries.scheduleRun.limit.modeCodexSandbox":
    "Esta programación solo se ejecuta mientras {agent}, el agente que la creó, está en No preguntar nunca con un sandbox al menos tan amplio como el de la programación, porque una programación se ejecuta sin nadie presente. Da ese acceso a {agent}, o elimina la programación y vuelve a crearla tú.",
  "systemEntries.scheduleRun.limit.folder":
    "Esta programación se ejecuta fuera de la carpeta de trabajo de {agent}, el agente que la creó. Cambia la carpeta de la programación o del agente.",
  "systemEntries.claudeAuth.connected":
    "Esta conversación puede seguir usando las credenciales con las que se inició. Inicia una conversación nueva (`/clear`) para usar la conexión actual de Claude.",
  "systemEntries.claudeAuth.incomplete":
    "No se pudo completar la comprobación de la conexión de Claude. Vuelve a intentar la solicitud o inicia sesión en Claude en Ajustes.",
  "systemEntries.signInRequired":
    "{provider} no pudo ejecutar este mensaje porque no ha iniciado sesión. Inicia sesión abajo para continuar.",
  "systemEntries.signInPrompt": "Inicia sesión en {provider} abajo.",
  "systemEntries.notSignedIn": "{provider} no ha iniciado sesión.",
  "systemEntries.signInRequiredOffice":
    "{provider} no pudo ejecutar este mensaje porque no ha iniciado sesión.",
  "systemEntries.signInRejected":
    "{provider} rechazó las credenciales. Cierra sesión abajo y vuelve a iniciarla.",
  "systemEntries.signInRejectedOffice":
    "{provider} rechazó las credenciales. Pide a un propietario de la oficina que inicie sesión.",
  "systemEntries.manageSignIn": "Gestiona tu sesión de {provider} abajo.",
  "systemEntries.alreadySignedIn":
    "Ya has iniciado sesión. Gestiona tu sesión de {provider} abajo.",
  "systemEntries.signOutOpenCode":
    "Cerrar sesión no está disponible en los agentes de OpenCode.",
  "systemEntries.signOutNoScope":
    "Cerrar sesión no está disponible porque no se pudo resolver el ámbito de esta cuenta de {provider}.",
  "systemEntries.runInTerminal":
    "Ejecuta `{command}` en el terminal integrado.",
  "updateNotice.pill.updateAvailable": "hay una actualización",
  "updateNotice.pill.newRelease": "nueva versión",
  "updateNotice.pill.mainAhead": "main +{count}",
  "updateNotice.title.newRelease": "Hay una versión nueva",
  "updateNotice.title.mainAhead": "Hay commits más nuevos en main",
  "updateNotice.running": "el commit {sha}",
  "updateNotice.identity.noLatest": "Estás en {running}.",
  "updateNotice.identity.current": "Estás en {running} (la última versión).",
  "updateNotice.identity.behind": "Estás en {running}; ya está {latest}.",
  "updateNotice.identity.aheadTagged":
    "Estás en {running} (más nuevo que la última versión, {latest}).",
  "updateNotice.identity.aheadUntagged":
    "Estás en {running}, por delante de la última versión ({latest}).",
  "updateNotice.identity.unknown":
    "Estás en {running}. La última versión es {latest};",
  "updateNotice.drift.beyond.one": "main tiene {count} commit más allá de eso.",
  "updateNotice.drift.beyond.other":
    "main tiene {count} commits más allá de eso.",
  "updateNotice.drift.newer.one": "main tiene {count} commit más nuevo.",
  "updateNotice.drift.newer.other": "main tiene {count} commits más nuevos.",
  "updateNotice.drift.bleedingEdge.one":
    "main tiene {count} commit más nuevo si quieres lo último de lo último.",
  "updateNotice.drift.bleedingEdge.other":
    "main tiene {count} commits más nuevos si quieres lo último de lo último.",
  "storageReport.heading": "Almacenamiento de Isomux",
  "storageReport.totalWithOutside":
    "**{total} en total:** {stateRoot} de estado de la oficina, más {outside} en {locations}.",
  "storageReport.totalOnly":
    "**{total} en total**, todo ello estado de la oficina.",
  "storageReport.locationsJoin": " y ",
  "storageReport.measured": "_Medido {age}._",
  "storageReport.columnCategory": "Categoría",
  "storageReport.columnSize": "Tamaño",
  "storageReport.columnFiles": "Archivos",
  "storageReport.none": "ninguno",
  "storageReport.totalOfficeState": "Total del estado de la oficina",
  "storageReport.total": "Total",
  "storageReport.outsideNote":
    '_Las copias de seguridad y las instantáneas de actualización están fuera del directorio de estado de la oficina, así que se listan después de su subtotal. "ninguno" significa que esa ubicación no está configurada en esta máquina._',
  "storageReport.locations": "_Ubicaciones: {paths}._",
  "storageReport.locationOfficeState": "estado de la oficina",
  "storageReport.locationNotSetUp": "{label} (sin configurar)",
  "storageReport.ownerOnly":
    "_El desglose por agente y las rutas son solo para el propietario de la oficina._",
  "storageReport.biggestAgents": "Agentes más grandes",
  "storageReport.columnAgent": "Agente",
  "storageReport.columnTranscripts": "Transcripciones",
  "storageReport.columnAttachments": "Adjuntos",
  "storageReport.columnSessions": "Sesiones",
  "storageReport.columnLastActivity": "Última actividad",
  "storageReport.killed": "_(eliminado)_",
  "storageReport.showing":
    "_Se muestran los {shown} agentes más grandes de {total} con datos guardados._",
  "storageReport.nothingDeleted":
    "_Aquí no se borra nada automáticamente. Las transcripciones y los adjuntos solo se eliminan cuando el propietario de la oficina lo pide._",

  // --- S9: the pre-sign-in pages the server renders itself -----------------
  // The claim page, the invite-accept page, the login page and the three
  // error pages of the same flow. No picker (ruling 5): the language comes
  // from the visitor's Accept-Language header, or from their stored
  // preference on the pages that can know them. The common.* keys here are
  // common because two of those pages share the byte-identical string
  // (ruling 15), not because anything outside this flow uses them yet.
  "common.continue": "Continuar",
  "common.displayName": "Nombre para mostrar",
  "common.returnToOffice": "Volver a la oficina",
  "common.welcomeNewOffice": "Te damos la bienvenida a tu nueva oficina Isomux",
  "common.titleFirstTimeSetup": "configuración inicial",
  "common.titleInvite": "invitación",
  "common.ogTitleFirstTimeSetup": "Isomux - configuración inicial",
  "preAuth.login.title": "iniciar sesión",
  "preAuth.login.openInvite":
    "Abre un enlace de invitación para iniciar sesión en este dispositivo.",
  "preAuth.login.alreadySignedIn":
    "¿Ya tienes sesión iniciada en otro sitio? Crea enlaces de invitación para tus otros dispositivos en Ajustes.",
  "preAuth.login.askOwner": "Si no, pídeselo al propietario de la oficina.",
  "preAuth.login.noOwner": "Esta oficina todavía no tiene propietario.",
  "preAuth.login.claimHere": "Abre {link} para reclamar la propiedad.",
  "preAuth.login.claimHereLink": "la página de inicio de esta oficina",
  "preAuth.login.sshHint":
    "Si quieres llegar a esta oficina desde otra máquina, primero necesitas un túnel SSH (el formulario de reclamación solo es accesible desde loopback). El registro de arranque del servidor indica el comando {command} exacto.",
  "preAuth.claim.intro":
    "Eres la primera persona que reclama esta oficina. Elige un nombre para mostrar; aparecerá junto a todo lo que digas.",
  "preAuth.claim.ogDescription":
    "Reclama la propiedad de una oficina Isomux nueva.",
  "preAuth.claim.errorOwnerExists":
    "Ya existe un propietario de la oficina. Actualiza la página e inicia sesión con un enlace de invitación.",
  "preAuth.claim.errorName":
    "Elige un nombre para mostrar (letras, números, espacios, puntos, guiones, apóstrofos o guiones bajos).",
  "preAuth.claim.keyLabel": "Clave de configuración",
  "preAuth.claim.keyFromFile":
    "El servidor mostró un enlace con esta clave al arrancar. La clave también está en {path} en el servidor.",
  "preAuth.claim.keyFromEnv":
    "Usa el valor de {name} de la configuración de despliegue de esta oficina.",
  "preAuth.claim.keyFromRender":
    "Render la creó al desplegar. Busca {name} en la configuración Environment del servicio.",
  "preAuth.claim.keyFromContainer":
    "Usa el valor de {name} configurado para este contenedor. Con la configuración AWS Compose, está en {file}.",
  "preAuth.claim.errorKey": "Falta la clave de configuración o no es correcta.",
  "preAuth.claim.errorTooManyTries":
    "Demasiadas claves de configuración incorrectas. Inténtalo de nuevo en un minuto.",
  "preAuth.invite.titleAccept": "aceptar invitación",
  "preAuth.invite.heading": "Abre tu invitación de Isomux",
  "preAuth.invite.headingNamed":
    "Abre tu invitación a la oficina Isomux: {office}",
  "preAuth.invite.clickHint":
    "Al pulsar el botón de abajo iniciarás sesión en este dispositivo.",
  "preAuth.invite.accept": "Aceptar y continuar",
  "preAuth.invite.errorName": "Elige un nombre para mostrar.",
  "preAuth.invite.ogTitleAccept": "Isomux - aceptar invitación",
  "preAuth.invite.ogDescriptionSetup":
    "Abre este enlace para reclamar la propiedad de una oficina Isomux.",
  "preAuth.invite.ogDescriptionAccept":
    "Abre este enlace para iniciar sesión en una oficina Isomux en este dispositivo.",
  "preAuth.inviteError.heading": "Invitación no disponible",
  "preAuth.inviteError.consumed": "Esta invitación ya se ha usado.",
  "preAuth.inviteError.expired": "Esta invitación ha caducado.",
  "preAuth.inviteError.roleMismatch":
    "Esta invitación no se puede aceptar porque el miembro que ya existe tiene otro rol. Pide a un propietario de la oficina que cree una invitación nueva.",
  "preAuth.inviteError.ownerExists":
    "Ya existe un propietario de la oficina. Las invitaciones iniciales dejan de funcionar cuando la oficina ya está reclamada.",
  "preAuth.inviteError.generic": "Esta invitación ya no es válida.",
  "preAuth.conflict.heading": "Esta invitación es para otro miembro",
  "preAuth.conflict.body":
    "Has iniciado sesión como {current}. Esta invitación es para {invitee}: ábrela en su dispositivo o en otro perfil del navegador.",
  "preAuth.signOutBlocked.title": "cierre de sesión bloqueado",
  "preAuth.signOutBlocked.heading": "Cierre de sesión bloqueado",
  "preAuth.signOutBlocked.lastOwnerSession":
    "Cierre de sesión rechazado: esta es la última sesión activa de un propietario de la oficina. Crea otra invitación para ti y acéptala en otro dispositivo antes de volver a intentarlo.",
  "demo.banner.short":
    "Esto es una demo. Para conectar agentes reales de Claude, Codex y OpenCode:",
  "demo.banner.long":
    "Esta es una oficina de demostración. Para conectar agentes reales de Claude, Codex y OpenCode:",
  "demo.reply":
    "Esto es una demo: tu mensaje no se ha enviado a Claude. Para usar Isomux de verdad, sigue las instrucciones de instalación en [isomux.com](https://isomux.com).",
  "demo.receptionistReply":
    "Bienvenidos al vestíbulo. En una oficina real respondo preguntas sobre Isomux y sobre esta oficina. Esto es una demo, así que no se ha enviado nada a un modelo.",
  "settings.sidebar.pager": "Avisos",
  "pager.settings.intro":
    "Los agentes te envían un aviso cuando te necesitan. Los avisos aparecen en tu bandeja de entrada y llegan a los sitios de abajo.",
  "pager.settings.thisDevice": "Este dispositivo",
  "pager.settings.discord": "Discord",
  "pager.settings.webhook": "URL del webhook",
  "pager.settings.webhookHint":
    "En Discord: ajustes del canal → Integraciones → Webhooks → Nuevo webhook → Copiar URL del webhook.",
  "pager.settings.webhookNone": "No configurado.",
  "pager.settings.webhookRemove": "Quitar webhook",
  "pager.settings.userId": "ID de usuario",
  "pager.settings.userIdHint":
    "Los avisos te mencionan para que Discord te notifique. En Discord: Ajustes de usuario → Avanzado → Modo desarrollador, y luego haz clic derecho en tu nombre (mantén pulsado en el móvil) → Copiar ID de usuario.",
  "pager.settings.repeat": "Repetir un aviso abierto",
  "pager.settings.repeatNever": "Nunca",
  "pager.settings.repeatEvery": "Cada {count} min",
  "pager.settings.phoneHint":
    "En tu móvil, deja activadas las notificaciones de Discord para este servidor, al menos para las @menciones.",
  "pager.settings.repeatEveryHours.other": "Cada {count} horas",
  "pager.settings.repeatEveryHours.one": "Cada {count} hora",
  "pager.settings.webhookSaved": "Guardada",
  "pager.settings.saved": "Guardado.",
  "pager.settings.loadFailed": "No se pudieron cargar los ajustes de avisos.",
  "pager.settings.test": "Enviar aviso de prueba",
  "pager.settings.testSent": "Aviso de prueba enviado.",
  "pager.settings.testFailed": "Aviso de prueba no enviado: {reason}.",
  "pager.failure.noWebhook": "Discord no configurado",
  "pager.failure.http4xx": "Discord rechazó el aviso",
  "pager.failure.http5xx": "error de Discord",
  "pager.failure.rateLimited": "límite de frecuencia de Discord",
  "pager.failure.network": "no se pudo contactar con Discord",
  "pager.discord.stillOpen": "Sigue abierto: {title}",
  "pager.discord.resolved": "Resuelto: {title}",
  "pager.discord.test": "Aviso de prueba de Isomux.",
  "nav.inbox": "Bandeja de entrada",
  "nav.inboxOpenCount.one": "Bandeja de entrada: {count} pendiente",
  "nav.inboxOpenCount.other": "Bandeja de entrada: {count} pendientes",
  "inbox.tab.pages": "Avisos",
  "pager.view.shown": "{count} mostrados",
  "pager.view.filterActive": "Abiertos y confirmados",
  "pager.view.stateFilter": "Estado",
  "pager.view.roomFilter": "Sala",
  "pager.view.filterAll": "Todos",
  "pager.view.allRooms": "Todas las salas",
  "pager.view.noRoom": "Sin sala",
  "pager.view.empty": "No hay avisos",
  "pager.view.hiddenElsewhere.one":
    "{count} aviso abierto oculto por el filtro de sala",
  "pager.view.hiddenElsewhere.other":
    "{count} avisos abiertos ocultos por el filtro de sala",
  "pager.view.showAllRooms": "Mostrar todas las salas",
  "pager.view.discordUnset":
    "Ni Discord ni las notificaciones del dispositivo están configurados, así que tus avisos se quedan en la oficina.",
  "pager.view.settingsLink": "Ajustes de avisos",
  "pager.view.loadFailed": "No se pudieron cargar los avisos.",
  "pager.view.retry": "Reintentar",
  "pager.view.loadMore": "Cargar más",
  "pager.view.unavailable":
    "Ese aviso no está disponible. No existe o está en una sala a la que no tienes acceso.",
  "pager.view.appSource": "{name} (app)",
  "pager.view.openChat": "Abrir el chat con {name}",
  "pager.view.openApp": "Abrir la app {name}",
  "pager.view.raised.one": "enviado {count} vez",
  "pager.view.raised.other": "enviado {count} veces",
  "pager.view.ackedBy": "Confirmado por {name}, {age}",
  "pager.view.resolvedBy": "Resuelto por {name}, {age}",
  "pager.state.open": "Abierto",
  "pager.state.acked": "Confirmado",
  "pager.state.resolved": "Resuelto",
  "pager.delivery.sent": "Enviado a Discord",
  "pager.delivery.pending": "Aún no enviado",
  "pager.delivery.notSent": "No enviado: {reason}",
  "pager.delivery.failed": "Falló el último envío: {reason}",
  "pager.action.ack": "Confirmar",
  "pager.action.resolve": "Resolver",
  "pager.action.failed": "No se pudo cambiar el aviso.",
  "apiCall.pagerSettings.read": "Leer los ajustes de avisos",
  "apiCall.pagerSettings.save": "Guardar los ajustes de avisos",
  "apiCall.pagerSettings.test": "Enviar aviso de prueba",
  "apiCall.voice.status": "Leer el estado de la clave de voz",
  "apiCall.voice.transcribe": "Transcribir una grabación",
  "apiCall.voice.speak": "Leer un texto en voz alta",
  "push.test": "Notificación de prueba de Isomux.",
  "push.turnEnd.title": "{agent} ha terminado",
  "push.settings.switch": "Notificaciones",
  "push.settings.test": "Enviar notificación de prueba",
  "push.settings.testSent": "Notificación de prueba enviada.",
  "push.settings.testFailed":
    "No se envió la notificación de prueba: {reason}.",
  "push.settings.iosInstall":
    "En iPhone y iPad, añade Isomux a la pantalla de inicio y ábrelo desde allí.",
  "push.settings.unsupported":
    "Este navegador no puede mostrar notificaciones push.",
  "push.settings.blocked":
    "Las notificaciones de Isomux están bloqueadas en los ajustes de este navegador.",
  "push.settings.failed":
    "No se pudieron cambiar las notificaciones de este dispositivo.",
  "push.settings.otherDevices": "Otros dispositivos ({count})",
  "push.settings.remove": "Eliminar",
  "push.settings.unnamed": "Dispositivo sin nombre",
  "push.failure.gone": "la suscripción ha caducado",
  "push.failure.rejected": "el servicio push la rechazó",
  "push.failure.unreachable": "no se puede contactar con el servicio push",
  "apiCall.pushDevices.list": "Listar dispositivos de notificaciones",
  "apiCall.pushDevices.add": "Activar notificaciones del dispositivo",
  "apiCall.pushDevices.remove": "Eliminar dispositivo de notificaciones",
  "apiCall.pushDevices.test": "Enviar notificación de prueba",
  "common.skills": "Habilidades",
  "skills.engine": "Motor",
  "skills.search": "Buscar habilidades",
  "skills.new": "Nueva habilidad",
  "skills.group.user": "Habilidades del usuario",
  "skills.group.project": "Habilidades del proyecto",
  "skills.group.plugin": "Habilidades de plugins",
  "skills.group.isomux": "Incluidas en Isomux",
  "skills.source.user": "Usuario",
  "skills.source.project": "Proyecto",
  "skills.source.plugin": "Plugin",
  "skills.source.isomux": "Incluida",
  "skills.readOnly": "Solo lectura",
  "skills.readOnly.isomux": "Incluida en Isomux. Solo lectura.",
  "skills.readOnly.plugin": "Instalada por el plugin {plugin}. Solo lectura.",
  "skills.uses.one": "{count} uso",
  "skills.uses.other": "{count} usos",
  "skills.noDescription": "Sin descripción.",
  "skills.notUsed": "No se ejecuta",
  "skills.shadowed":
    "No se ejecuta en {engine}. Primero va una habilidad con el mismo nombre:",
  "skills.field.project": "Proyecto",
  "skills.field.alias": "También se ejecuta como",
  "skills.field.engines": "Funciona en",
  "skills.delete.title": "¿Eliminar /{name}?",
  "skills.delete.folder":
    "Se eliminará la carpeta de la habilidad, incluidos sus scripts y recursos. Se eliminan los enlaces, pero se conservan sus destinos.",
  "skills.delete.command":
    "Se eliminará el archivo del comando. Si es un enlace, se conservará su destino.",
  "skills.delete.stale":
    "El archivo ha cambiado. Vuelve a abrirlo antes de eliminarlo.",
  "skills.delete.failed": "No se pudo eliminar la habilidad.",
  "apiCall.skills.delete": "Eliminar una habilidad",
  "skills.commands": "Comandos",
  "skills.commands.note":
    "Estos comandos vienen integrados; no son habilidades.",
  "skills.commands.search": "Buscar comandos",
  "skills.allAgents": "Todos los agentes",
  "skills.invalid.frontmatter":
    "Empieza el archivo con metadatos YAML entre líneas ---.",
  "skills.invalid.unclosed": "Cierra los metadatos YAML con una línea ---.",
  "skills.invalid.yaml": "Los metadatos contienen YAML no válido.",
  "skills.invalid.mapping": "Los metadatos deben contener campos YAML.",
  "skills.invalid.name": "Añade un campo name con un valor de texto no vacío.",
  "skills.invalid.description":
    "Añade un campo description con un valor de texto no vacío.",
  "skills.view.source": "SKILL.md",
  "skills.view.preview": "Vista previa",
  "skills.select": "Elige una habilidad para leer su SKILL.md.",
  "skills.empty": "No hay habilidades que coincidan.",
  "skills.backToList": "Todas las habilidades",
  "skills.loadFailed": "No se pudieron cargar las habilidades.",
  "skills.readFailed": "No se pudo leer esta habilidad.",
  "skills.saveStale":
    "No se guardó: el archivo cambió en el disco después de que lo abrieras. Copia tu edición y recarga.",
  "skills.saveDeleted": "No se guardó: el archivo se borró del disco.",
  "skills.reload": "Recargar",
  "skills.create.title": "Nueva habilidad",
  "skills.create.nameHint": "Minúsculas, dígitos y guiones.",
  "skills.create.invalidName":
    "Usa minúsculas, dígitos y guiones sueltos, hasta 64 caracteres.",
  "skills.create.description": "Descripción",
  "skills.create.descriptionHint":
    "Una línea. Los agentes la leen para decidir cuándo usar la habilidad.",
  "skills.create.invalidDescription":
    "Escribe la descripción en una línea, hasta 1024 caracteres.",
  "skills.create.instructions": "Instrucciones",
  "skills.create.instructionsPlaceholder":
    "Lo que hace el agente cuando alguien ejecuta esta habilidad.",
  "skills.create.agentHint":
    "Puedes pedir a tus agentes que creen habilidades para ti.",
  "skills.create.allAgents": "Todos los agentes pueden usar esta habilidad.",
  "skills.create.where": "Se guarda como {path}",
  "skills.create.exists": "Ya existe una habilidad con este nombre.",
  "skills.create.failed": "No se pudo crear la habilidad.",
  "skills.create.submit": "Crear",
  "apiCall.skills.list": "Listar habilidades",
  "apiCall.skills.read": "Leer una habilidad",
  "apiCall.skills.save": "Guardar una habilidad",
  "apiCall.skills.create": "Crear una habilidad",
  "appWidget.launcher": "Chat",
  "appWidget.title": "Chat con {agentName}",
  "appWidget.notice": "Compartido con los miembros de la sala del agente.",
  "appWidget.windowsHint":
    "Para compartir una captura de pantalla: pulsa Win+Shift+S y luego pégala aquí.",
  "appWidget.macHint":
    "Para compartir una captura de pantalla: pulsa Shift+Command+4 y luego arrástrala aquí.",
  "appWidget.genericHint":
    "Para compartir una captura de pantalla: haz una y luego pégala o adjúntala aquí.",
  "appWidget.attach": "Adjuntar imagen",
  "appWidget.direct": "Abrir sin el chat",
  "appWidget.unavailable": "El chat no está disponible.",
  "appWidget.install": "Instalar como app",
  "appWidget.installSteps":
    "Toca Compartir y luego Añadir a pantalla de inicio.",
  "appWidget.installConfirm": "Instalar {appName}",
  "officeInstall.notice": "Isomux funciona mejor como app.",
  "officeInstall.noticeSteps":
    "Isomux funciona mejor como app. Toca Compartir y luego Añadir a pantalla de inicio.",
  "officeInstall.install": "Instalar",
};
