// Spanish. Informal register (tú), never usted (ruling 1). Button labels use
// the infinitive, the Spanish UI convention. Proper nouns, commands and the
// word DELETE that the storage confirm asks for stay as they are (ruling 11).

import type { Catalog } from "./en.ts";

export const es: Catalog = {
  "common.save": "Guardar",
  "common.saving": "Guardando…",
  "common.saved": "Guardado",
  "common.cancel": "Cancelar",
  "common.loading": "Cargando…",
  "common.loadingMemory": "Cargando la memoria…",
  "common.memory": "Memoria",
  "common.memoryEditorHint":
    "Este editor reescribe el archivo tal como se muestra. Usa una memoria por línea.",
  "common.saveFailed": "No se pudo guardar",
  "common.nextConversation":
    "Los cambios se aplican en la siguiente conversación.",
  "common.settings": "Ajustes",
  "common.theme": "Tema",
  "common.preferences": "Preferencias",
  "common.checking": "Comprobando…",

  "nav.tasks": "Tareas",
  "nav.schedules": "Programaciones",
  "nav.apps": "Apps",
  "nav.changeTheme": "Cambiar el tema",
  "nav.showAgentList": "Mostrar la lista de agentes",
  "nav.showFloorView": "Mostrar la vista de planta",

  "preferences.intro":
    "Te siguen a todos los dispositivos desde los que inicias sesión. Los ajustes propios de este navegador están en Mis dispositivos.",
  "preferences.language": "Idioma",
  "preferences.languageHint":
    "El idioma en que escriben tus agentes, y el que usan tu entrada de voz y la lectura en voz alta. Los agentes lo aplican en su siguiente conversación. El resto de la interfaz sigue en inglés por ahora.",
  "preferences.saved": "Guardado.",
  "preferences.saveFailed": "No se pudo guardar",

  "settings.backToOffice": "Volver a la oficina",
  "settings.selectHint": "Elige un ajuste de la lista",
  "settings.profilesNote":
    "Los perfiles de usuario se guardan en el servidor. Tus notificaciones y credenciales te siguen entre dispositivos.",
  "settings.signOut": "Cerrar sesión",
  "settings.signOutHint": "Cierra la sesión de este dispositivo",
  "settings.you": "(tú)",
  "settings.sidebar.office": "Oficina",
  "settings.sidebar.access": "Acceso",
  "settings.sidebar.invites": "Invitaciones",
  "settings.sidebar.sessions": "Sesiones",
  "settings.sidebar.connectionsOffice": "Conexiones de toda la oficina",
  "settings.sidebar.usage": "Uso",
  "settings.sidebar.storage": "Almacenamiento",
  "settings.sidebar.updates": "Actualizaciones",
  "settings.sidebar.you": "Tú",
  "settings.sidebar.profile": "Perfil",
  "settings.sidebar.connectionsPersonal": "Conexiones individuales",
  "settings.sidebar.apiTokens": "Tokens de API",
  "settings.sidebar.signInLinks": "Enlaces de inicio de sesión",
  "settings.sidebar.device": "Dispositivo",
  "settings.sidebar.deviceLabel": "Etiqueta del dispositivo",
  "settings.sidebar.rooms": "Salas",
  "settings.sidebar.members": "Miembros",
  "settings.members.editHint":
    "Solo el propio usuario y los propietarios pueden editar un usuario",
  "settings.members.onlineNow": "En línea ahora",
  "settings.members.online": "en línea",
  "settings.members.onlineSessions.one": "en línea · {count} sesión",
  "settings.members.onlineSessions.other": "en línea · {count} sesiones",
  "settings.members.lastSeen": "visto por última vez {when}",
  "settings.role.owner": "propietario",
  "settings.role.member": "miembro",
  "settings.role.ownerHint":
    "Propietario - puede invitar usuarios, revocar sesiones y fijar el acceso a salas de cada usuario",
  "settings.role.memberHint":
    "Miembro - puede actuar en las salas que el propietario le permitió; no puede invitar ni revocar",

  "settings.profile.identity": "Identidad",
  "settings.profile.displayName": "Nombre visible",
  "settings.profile.rooms": "Salas",
  "settings.profile.accessHint":
    "Acceso: salas que este usuario puede ver y en las que puede actuar (lo gestiona el propietario).",
  "settings.profile.viewHint":
    "Mostradas: cuáles de tus salas accesibles aparecen en tu vista. Notificaciones: sonido cuando un agente de esa sala termina. Una sala debe estar mostrada para notificar.",
  "settings.profile.roomColumn": "Sala",
  "settings.profile.accessColumn": "Acceso",
  "settings.profile.displayedColumn": "Mostrada",
  "settings.profile.notificationsColumn": "Notificaciones",
  "settings.profile.noRooms": "Aún no hay salas.",
  "settings.profile.accessTo": "Acceso a {room}",
  "settings.profile.display": "Mostrar {room}",
  "settings.profile.notificationsFor": "Notificaciones de {room}",
  "settings.profile.agentContext": "Contexto para agentes",
  "settings.profile.profilePrompt": "Prompt de perfil",
  "settings.profile.profilePromptHint":
    "(se inyecta en el prompt de sistema de los agentes que posees; los agentes de otros usuarios pueden consultarlo si necesitan contexto sobre ti)",
  "settings.profile.profilePromptTitle": "{user} · Prompt de perfil",
  "settings.profile.profilePromptExpandedHint":
    "Se inyecta en el prompt de sistema de los agentes que posee este usuario; los agentes de otros usuarios pueden consultarlo si necesitan contexto sobre él.",
  "settings.profile.profilePromptPlaceholder":
    "Unas notas para los agentes sobre quién eres, tu rol, cómo te gusta colaborar…",
  "settings.profile.memoryHint":
    "(hechos duraderos sobre este usuario; reescribe el archivo tal como se muestra - una memoria por línea; {size} / {cap})",
  "settings.profile.memoryTitle": "{user} · Memoria",
  "settings.profile.memoryPlaceholder":
    "Alguna memoria relevante para este usuario",
  "settings.profile.appearance": "Apariencia",
  "settings.profile.avatar": "Avatar",
  "settings.profile.avatarHint":
    "(tu fantasma en la escena de la oficina; los demás usuarios lo ven junto al agente que estás viendo)",
  "settings.profile.discardPrompt": "¿Descartar los cambios sin guardar?",
  "settings.profile.discard": "Descartar",
  "settings.profile.delete": "Eliminar",
  "settings.profile.deleteHint": "Eliminar este usuario",
  "settings.profile.confirmDelete": "¿Confirmar?",
  "settings.profile.deleteFailed": "No se pudo eliminar",
  "settings.profile.roomListFailed":
    "No se pudo confirmar tu lista de salas; Mostradas no se guardó.",

  "settings.office.title": "Ajustes de la oficina",
  "settings.office.intro":
    "El cartel enmarcado de la pared de la oficina abre esta página.",
  "settings.office.viewOnly":
    "Solo lectura. Solo los propietarios de la oficina pueden editar los ajustes de toda la oficina.",
  "settings.office.name": "Nombre de la oficina",
  "settings.office.nameHint":
    "(opcional, se muestra en la pestaña del navegador)",
  "settings.office.namePlaceholder": "Oficina de Nil",
  "settings.office.rules": "Reglas",
  "settings.office.rulesHint": "(prompt de sistema para todos los agentes)",
  "settings.office.rulesTitle": "Reglas de la oficina",
  "settings.office.rulesExpandedHint":
    "Prompt de sistema para todos los agentes. Los cambios se aplican en la siguiente conversación.",
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
  "settings.office.loadedVariables.one": "Se cargó {count} variable.",
  "settings.office.loadedVariables.other": "Se cargaron {count} variables.",
  "settings.office.discardConfirm":
    "¿Descartar los cambios sin guardar de la oficina?",

  "settings.room.title": "{room} · Ajustes",
  "settings.room.intro":
    "Haz doble clic en la pestaña de una sala para venir directamente aquí.",
  "settings.room.name": "Nombre",
  "settings.room.namePlaceholder": "Nombre de la sala",
  "settings.room.prompt": "Prompt de la sala",
  "settings.room.promptHint":
    "(opcional, se añade después del prompt de la oficina)",
  "settings.room.promptTitle": "{room} · Prompt de la sala",
  "settings.room.promptPlaceholder":
    "p. ej. Estás en la sala de Marketing. Sigue la voz de nuestra marca.",
  "settings.room.promptNote":
    "Los cambios se aplican en la siguiente conversación. Define las variables de entorno en Conexiones de toda la oficina o Conexiones individuales.",
  "settings.room.memoryHint":
    "(hechos duraderos de esta sala; líneas en bruto; {size} / {cap})",
  "settings.room.memoryTitle": "{room} · Memoria",
  "settings.room.memoryPlaceholder": "Alguna memoria relevante para esta sala",
  "settings.room.reloadFailed":
    "Guardado, pero esta página no pudo recargar la sala. Elige otra fila y vuelve para seguir editando.",
  "settings.room.conflict":
    "Los ajustes de la sala cambiaron en otro sitio desde que se cargó esta página. Elige otra fila y vuelve para cargar la última versión.",
  "settings.room.deleteEmpty": "Eliminar la sala vacía",
  "settings.room.discardConfirm":
    "¿Descartar los cambios sin guardar de esta sala?",

  "settings.theme.intro":
    "Se guarda en este navegador. También puedes hacer clic en la ventana de la oficina para recorrer los temas sin abrir esta página.",

  "settings.device.intro":
    'Se guarda en este navegador. Dice a los agentes en qué dispositivo estás (por ejemplo "Móvil" frente a "Portátil") para que adapten sus respuestas.',
  "settings.device.label": "Etiqueta del dispositivo",
  "settings.device.optional": "(opcional)",
  "settings.device.placeholder": "Móvil, Portátil, …",
  "settings.device.discardConfirm":
    "¿Descartar los cambios sin guardar de la etiqueta del dispositivo?",

  "settings.devices.title": "Mis dispositivos",
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
  "settings.update.requested":
    "Actualización solicitada. El servidor se reiniciará en breve y esta página se volverá a conectar. Si no pasa nada tras unos minutos, revisa el archivo de estado del actualizador en el servidor.",
  "settings.update.close": "Cerrar",
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
  "settings.update.ownerOnly":
    "Un propietario de la oficina puede aplicarla desde este diálogo.",
  "settings.update.updateNow": "Actualizar ahora",
  "settings.update.updateNowBusy": "Actualizar ahora ({count} ocupados)",
  "settings.update.updating": "Actualizando…",
  "settings.update.gotIt": "Entendido",

  "settings.usage.title": "Uso de la oficina",
  "settings.usage.intro":
    "Los límites del plan de suscripción no se muestran aquí. Esta página informa del uso de tokens y del coste estimado que registra Isomux.",
  "settings.usage.scoped":
    "Limitado a las salas a las que tienes acceso. El uso de las programaciones no se incluye.",
  "settings.usage.loadFailed": "No se pudo cargar el uso.",
  "settings.usage.agents": "Uso por agente",
  "settings.usage.agentColumn": "Agente",
  "settings.usage.rooms": "Uso por sala",
  "settings.usage.roomsNote":
    "Los agentes eliminados cuentan en la última sala en la que estuvieron.",
  "settings.usage.roomColumn": "Sala",
  "settings.usage.deleted": "eliminada",
  "settings.usage.schedules": "Uso por programación",
  "settings.usage.scheduleColumn": "Programación",
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
  "settings.storage.category.attachments": "Adjuntos del chat",
  "settings.storage.category.sessionMetadata": "Metadatos de sesión",
  "settings.storage.category.codexHome": "Directorio de Codex",
  "settings.storage.category.providerHomes":
    "Directorios personales de proveedores",
  "settings.storage.category.cronjobs": "Historial de programaciones",
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
  "settings.storage.skip.queueStateUnknown":
    "esperan en una cola de mensajes que no se pudo leer",
  "settings.storage.measureFailed": "No se pudo medir el almacenamiento.",
  "settings.storage.previewFailed": "La solicitud de limpieza falló.",
  "settings.storage.deleteFailed": "La solicitud de borrado falló.",
  "settings.storage.deleteDidNotRun":
    "El borrado no se ejecutó. No se eliminó nada.",
  "settings.storage.leaveConfirm":
    "Aún hay una limpieza en marcha. Si sales ahora pierdes el único informe de lo que borró. ¿Salir de todos modos?",
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
    "conversaciones más recientes, por antiguas que sean. 0 no conserva ninguna por ese criterio.",
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
};
