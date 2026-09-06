// Spanish. Informal register (tú), never usted (ruling 1). Button labels use
// the infinitive, the Spanish UI convention. Proper nouns, commands and the
// word DELETE that the storage confirm asks for stay as they are (ruling 11).

import type { Catalog } from "./en.ts";

export const es: Catalog = {
  "common.save": "Guardar",
  "common.saving": "Guardando…",
  "common.saved": "Guardado",
  "common.cancel": "Cancelar",
  "common.close": "Cerrar",
  "common.loading": "Cargando…",
  "common.loadingDots": "Cargando...",
  "common.loadingMemory": "Cargando la memoria…",
  "common.memory": "Memoria",
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
  "common.settings": "Ajustes",
  "common.theme": "Tema",
  "common.preferences": "Preferencias",
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
  "common.rules": "Reglas",
  "common.role": "Rol",
  "common.rooms": "Salas",
  "common.signOut": "Cerrar sesión",
  "common.user": "Usuario",
  "common.schedules": "Programaciones",
  "common.apps": "Apps",
  "common.changeTheme": "Cambiar el tema",

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
  "settings.sidebar.profile": "Perfil",
  "settings.sidebar.connectionsPersonal": "Conexiones individuales",
  "settings.sidebar.apiTokens": "Tokens de API",
  "settings.sidebar.signInLinks": "Enlaces de inicio de sesión",
  "settings.sidebar.deviceLabel": "Etiqueta del dispositivo",
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
  "settings.profile.accessHint":
    "Acceso: salas que este usuario puede ver y en las que puede actuar (lo gestiona el propietario).",
  "settings.profile.viewHint":
    "Mostradas: cuáles de tus salas accesibles aparecen en tu vista. Notificaciones: sonido cuando un agente de esa sala termina. Una sala debe estar mostrada para notificar.",
  "settings.profile.roomColumn": "Sala",
  "settings.profile.accessColumn": "Acceso",
  "settings.profile.displayedColumn": "Mostrada",
  "settings.profile.notificationsColumn": "Notificaciones",
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
  "settings.profile.avatarHint":
    "(tu fantasma en la escena de la oficina; los demás usuarios lo ven junto al agente que estás viendo)",
  "settings.profile.deleteHint": "Eliminar este usuario",
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

  "settings.invites.intro":
    "Añade un miembro o un propietario: emite una URL de invitación y envíasela por otro canal. Al abrirla se crea su cuenta y ese dispositivo entra. Para más dispositivos en una cuenta que ya existe, cada persona genera su propio enlace desde <i>Mis dispositivos</i>.",
  "settings.invites.issueFor": "Emitir invitación para…",
  "settings.invites.namePlaceholder": "Nombre nuevo (p. ej. Marc)",
  "settings.invites.existing":
    "<b>{name}</b> ya existe, así que no hace falta ninguna invitación: para entrar con otro dispositivo, {name} puede generar un enlace desde <i>Mis dispositivos</i> en sus propios ajustes - o le puedes emitir un enlace de recuperación aquí abajo.",
  "settings.invites.grantRoom": "Dar acceso a {room}",
  "settings.invites.roomsHint":
    "La persona invitada entra con acceso a las salas marcadas. Déjalas todas sin marcar para dar acceso más tarde desde sus ajustes.",
  "settings.invites.expiryHint":
    "El enlace de invitación caduca 24 h después de emitirlo si no se usa. Las sesiones aceptadas duran hasta 1 año (revocables desde la sección Sesiones en cualquier momento).",
  "settings.invites.minting": "Emitiendo…",
  "settings.invites.issue": "Emitir invitación",
  "settings.invites.mintFailed": "No se ha podido emitir la invitación",
  "settings.invites.recovery": "Recuperación",
  "settings.invites.recoveryHint":
    "Ayuda a alguien que ya tiene cuenta a volver a entrar. Los enlaces de dispositivo son autoservicio, pero quien ha salido de todos sus dispositivos no puede generarse uno - elige a esa persona aquí y envíale el enlace por otro canal. Caduca en 24 h; al emitir uno nuevo se sustituye el anterior.",
  "settings.invites.selectUser": "Elige a alguien…",
  "settings.invites.mintRecovery": "Emitir enlace de recuperación",
  "settings.invites.recoveryFailed":
    "No se ha podido emitir el enlace de recuperación",
  "settings.invites.outstanding": "Invitaciones pendientes",
  "settings.invites.columnFor": "Para",
  "settings.invites.columnExpires": "Caduca",
  "settings.invites.bootstrap": "(inicial)",

  "settings.sessions.intro":
    "Dispositivos que han entrado en esta oficina, de todas las personas. Revocar una sesión saca a ese dispositivo. Quien es nuevo recibe una invitación desde la sección Invitaciones; quien ya tiene cuenta añade dispositivos desde <i>Mis dispositivos</i>.",
  "settings.sessions.columnLastSeen": "Visto por última vez",
  "settings.sessions.columnCreated": "Creada",
  "settings.sessions.currentSession": "Sesión actual",
  "settings.sessions.currentSessionHint":
    "Usa Cerrar sesión al final de la barra lateral para terminar tu sesión actual.",
  "settings.sessions.expiryInactivity": "Caduca por inactividad",
  "settings.sessions.expiryLatest": "Caduca como muy tarde",

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
  "settings.externalAccess.envInvalid":
    "Nota: <code>ISOMUX_PUBLIC_ORIGIN</code> está definida en el entorno pero no es un origen público válido, así que el servidor la ignora. Quítala de tu archivo de entorno o ponle <code>{pattern}</code> o <code>{localhost}</code>.",
  "settings.externalAccess.envMatches":
    "Nota: <code>ISOMUX_PUBLIC_ORIGIN={origin}</code> está definida en el entorno y coincide con esta URL pública. La variable de entorno está obsoleta - quítala de tu archivo de entorno cuando hayas guardado este valor en la configuración de la oficina.",
  "settings.externalAccess.envConflict":
    "Nota: <code>ISOMUX_PUBLIC_ORIGIN={origin}</code> está definida en el entorno. Al reiniciar tendría prioridad sobre cualquier valor distinto guardado aquí, así que se rechazará el guardado hasta que iguales esta URL al valor del entorno o quites la variable del entorno del servicio.",
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

  "settings.connections.officeIntro":
    "Las cuentas y variables que usa cada agente de esta oficina. Las credenciales las guarda el proveedor, no nosotros.",
  "settings.connections.personalIntro":
    "Las cuentas y variables que usan los agentes que creas tú. Tienen prioridad sobre las de la oficina. Las credenciales las guarda el proveedor, no nosotros.",
  "settings.connections.refresh": "Actualizar",
  "settings.connections.refreshing": "Actualizando…",
  "settings.connections.checkFailed":
    "No se han podido comprobar las cuentas de proveedor.",
  "settings.connections.envTitle": "Variables de entorno",
  "settings.connections.officeVars":
    "Variables para cada agente de esta oficina",
  "settings.connections.officeVarsHint":
    "Estas variables se cargan para cada agente salvo que una variable de usuario tenga prioridad.",
  "settings.connections.ownerManaged":
    "Las variables de toda la oficina las gestiona una persona propietaria.",
  "settings.connections.personalVars": "Variables para los agentes que creo",
  "settings.connections.personalVarsHint":
    "Estas variables se cargan para los agentes que creas y tienen prioridad sobre las de toda la oficina.",
  "settings.connections.providerKeyNote":
    "Añade <code>ANTHROPIC_API_KEY</code>, <code>OPENAI_API_KEY</code> u <code>OPENCODE_API_KEY</code> para usar claves de API del proveedor. Las demás variables por usuario funcionan igual; por ejemplo, cada miembro puede poner <code>GH_TOKEN</code> para que sus agentes usen sus propias credenciales de GitHub. Después haz <code>/clear</code> a los agentes para aplicar los cambios.",
  "settings.connections.crossLinkFromOffice":
    "Tus propias sesiones y variables, que tienen prioridad sobre estas, están en <link>Tú → Conexiones individuales</link>.",
  "settings.connections.crossLinkFromPersonal":
    "Las sesiones y variables de toda la oficina sobre las que estas tienen prioridad están en <link>Oficina → Conexiones de toda la oficina</link>.",

  "settings.signIn.apiKeyNote":
    "¿Quieres usar un token de API? Mira Ajustes → Tú → Conexiones individuales.",
  "settings.signIn.scopeOffice":
    "Toda la oficina: inicia sesión para cada agente de esta oficina",
  "settings.signIn.scopePersonal":
    "Individual: inicia sesión para los agentes que creo",
  "settings.signIn.officeHint":
    "Esta suscripción se usa para cada agente de la oficina salvo los que crea un miembro que haya configurado sus <link>Conexiones individuales</link>.",
  "settings.signIn.personalHint": "Usa una cuenta aparte para tus agentes.",
  "settings.signIn.status": "Estado:",
  "settings.signIn.checking": "Comprobando la conexión…",
  "settings.signIn.waiting": "Esperando al proveedor…",
  "settings.signIn.connectedAs": "Conectado como {account}",
  "settings.signIn.connected": "Conectado",
  "settings.signIn.unavailable": "Conexión no disponible",
  "settings.signIn.notConnected": "Sin conectar",
  "settings.signIn.startFailed":
    "No se ha podido iniciar sesión en {provider}.",
  "settings.signIn.submitFailed": "No se ha podido enviar el código de Claude.",
  "settings.signIn.cancelFailed":
    "No se ha podido cancelar el inicio de sesión.",
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
  "settings.env.hideValues": "Ocultar los valores",
  "settings.env.showValues": "Mostrar los valores",
  "settings.env.save": "Guardar las variables",
  "settings.env.saved": "Variables guardadas",
  "settings.env.duplicate":
    "Los nombres de las variables no se pueden repetir.",

  "settings.memberConnections.title": "Conexiones individuales",
  "settings.memberConnections.hint":
    "Variables que esta persona ha puesto para sus propios agentes. Solo los nombres - los valores quedan privados.",
  "settings.memberConnections.loadFailed":
    "No se han podido cargar las variables.",
  "settings.memberConnections.empty": "No hay variables.",
  "dialogs.textarea.expand": "Ampliar {title}",
  "dialogs.textarea.escCollapse": "Esc para plegar",
  "dialogs.textarea.done": "Hecho",

  "dialogs.schedulePrompt.title": "Ajustes de las programaciones",
  "dialogs.schedulePrompt.rulesHint":
    "(prompt de sistema para todas las programaciones)",
  "dialogs.schedulePrompt.rulesPlaceholder":
    "p. ej. Escribe siempre los hallazgos en un archivo markdown. Sé conciso.",
  "dialogs.schedulePrompt.appliedNextRun":
    "Se aplica a la próxima ejecución; las que están en curso usan la copia que capturaron.",
  "common.field.engine": "Motor",
  "common.field.model": "Modelo",
  "common.field.effort": "Esfuerzo de razonamiento",
  "common.field.sandbox": "Sandbox",
  "common.field.permissionMode": "Modo de permisos",
  "common.field.approvalPolicy": "Política de aprobación",
  "common.field.workingDirectory": "Directorio de trabajo",

  "common.effort.minimal": "Mínimo (solo Codex)",
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
  "dialogs.agent.engineBlurb.claude": "Funciona con tu cuenta de Claude Code.",
  "dialogs.agent.engineBlurb.codex": "Funciona con tu cuenta de ChatGPT.",
  "dialogs.agent.engineBlurb.opencode":
    "Funciona con los modelos configurados a través de OpenCode.",
  "dialogs.agent.engineSwitchHint":
    "Cambiar a {engine} empieza una conversación nueva. La actual se queda en el historial de sesiones de este agente.",
  "dialogs.agent.template": "Empezar con una plantilla",
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
    "Se fija al crear el agente - el responsable no se puede cambiar después.",
  "dialogs.agent.managerNoUser": "(sin usuario asignado)",
  "dialogs.agent.managerUnowned": "(sin propietario)",
  "dialogs.agent.managerHint":
    "Vinculado al usuario que lo crea. Determina qué variables personales se cargan en cada sesión (mira Ajustes → Tú → Conexiones individuales).",
  "dialogs.agent.privileged": "Acceso de operador con privilegios",
  "dialogs.agent.privilegedHint":
    "Permite a este agente dirigir las sesiones de otros agentes (reanudar, conversación nueva, enviar ahora) y gestionar sus propios cronjobs, con los permisos por sala del usuario que lo creó. Sigue actuando como el agente, nunca como el usuario.",
  "dialogs.agent.privilegedRestart":
    "Al guardar se reinicia la sesión del agente.",
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
  "dialogs.agent.optional": "(opcional)",
  "dialogs.agent.customInstructionsHint":
    "Prompt de sistema personal para este agente. Ejecuta /isomux-system-prompt en un chat para ver el prompt de sistema completo del agente.",
  "dialogs.agent.customInstructionsPlaceholder":
    'p. ej. "Eres un especialista en backend. Escribe siempre tests."',
  "dialogs.agent.systemPromptHint":
    "Ejecuta <code>/isomux-system-prompt</code> en un chat para ver el prompt de sistema completo del agente.",
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
  "apiCall.tasks.list": "Listar tareas",
  "apiCall.tasks.create": "Crear tarea",
  "apiCall.tasks.claim": "Reclamar tarea",
  "apiCall.tasks.complete": "Completar tarea",
  "apiCall.tasks.update": "Actualizar tarea",
  "apiCall.tasks.delete": "Eliminar tarea",
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
  "apiCall.agents.listInvalidFilter":
    "Listar agentes (filtro de eliminados no válido)",
  "apiCall.agents.sendMessage": "Enviar un mensaje a un agente",
  "apiCall.agents.sendMessageTo": "Enviar un mensaje a {who}",
  "apiCall.agents.steerMessage": "Interrumpir a {who} con un mensaje",
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
  "apiCall.agents.showDiff": "Mostrar un diff en el chat",
  "apiCall.agents.showDiffDetail": "Mostrar un diff en el chat",
  "apiCall.agents.offerFile": "Ofrecer un archivo en el editor",
  "apiCall.agents.offerFileDetail": "Ofrecer un archivo en el editor",
  "apiCall.agents.suggestCommand": "Sugerir un comando de terminal",
  "apiCall.agents.suggestCommandDetail": "Sugerir un comando de terminal",
  "apiCall.agents.context": "Consultar el uso del contexto",
  "apiCall.agents.logsSearch": "Buscar en los registros de conversación",
  "apiCall.agents.logsSearchFor": 'Buscar "{query}" en los registros de {who}',
  "apiCall.agents.logsAround":
    "Leer alrededor de una entrada en los registros de {who}",
  "apiCall.agents.logsSession": "Leer una sesión de los registros de {who}",
  "apiCall.agents.logsList": "Listar las sesiones de los registros de {who}",
  "apiCall.agents.instructions": "Leer las instrucciones del agente",
  "apiCall.agents.clearConversation": "Borrar la conversación de {who}",
  "apiCall.agents.flushQueue": "Vaciar ahora la cola de {who}",
  "apiCall.agents.interrupt": "Interrumpir a {who}",
  "apiCall.agents.resume": "Reanudar una sesión de {who}",
  "apiCall.agents.sessions": "Listar las sesiones de {who}",
  "apiCall.agents.move": "Mover a {who}",
  "apiCall.agents.revive": "Revivir a {who}",
  "apiCall.agents.cancelQueued": "Cancelar un mensaje en cola para {who}",
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
  "apiCall.env.readUser": "Leer el entorno gestionado",
  "apiCall.env.saveUser": "Guardar el entorno gestionado",
  "apiCall.env.readOffice": "Leer el entorno de la oficina",
  "apiCall.env.saveOffice": "Guardar el entorno de la oficina",
  "apiCall.inbox.messageBoss": "Enviar un mensaje al jefe remoto",
  "apiCall.inbox.drain": "Vaciar la bandeja del token de API",
  "apiCall.memory.read": "Leer la memoria",
  "apiCall.memory.append": "Añadir a la memoria",
  "apiCall.memory.replace": "Reemplazar la memoria",
  "apiCall.memory.readAgent": "Leer las memorias de este agente",
  "apiCall.memory.readRoom": "Leer las memorias de la sala",
  "apiCall.memory.readOffice": "Leer las memorias de la oficina",
  "apiCall.memory.readBoss": "Leer las memorias del jefe",
  "apiCall.memory.readAny": "Leer las memorias",
  "apiCall.memory.saveAgent": "Guardar una memoria para este agente",
  "apiCall.memory.saveRoom": "Guardar una memoria de sala",
  "apiCall.memory.saveOffice": "Guardar una memoria de oficina",
  "apiCall.memory.saveBoss": "Guardar una memoria de jefe",
  "apiCall.memory.save": "Guardar una memoria",
  "apiCall.memory.rewriteAgent": "Reescribir las memorias de este agente",
  "apiCall.memory.rewriteRoom": "Reescribir las memorias de la sala",
  "apiCall.memory.rewriteOffice": "Reescribir las memorias de la oficina",
  "apiCall.memory.rewriteBoss": "Reescribir las memorias del jefe",
  "apiCall.memory.rewriteAny": "Reescribir las memorias",
  "apiCall.rooms.create": "Crear una sala",
  "apiCall.rooms.createNamed": "Crear la sala {name}",
  "apiCall.rooms.rename": "Renombrar la sala como {name}",
  "apiCall.rooms.setPet": "Poner la mascota de una sala",
  "apiCall.rooms.update": "Actualizar una sala",
  "apiCall.rooms.close": "Cerrar una sala",
  "apiCall.rooms.updateSettings": "Actualizar los ajustes de la sala",
  "apiCall.rooms.swapDesks": "Intercambiar escritorios en una sala",
  "apiCall.cronjobs.list": "Listar las programaciones",
  "apiCall.cronjobs.create": "Crear una programación",
  "apiCall.cronjobs.read": "Leer una programación",
  "apiCall.cronjobs.update": "Actualizar una programación",
  "apiCall.cronjobs.delete": "Eliminar una programación",
  "apiCall.cronjobs.listRuns": "Listar las ejecuciones de una programación",
  "apiCall.cronjobs.triggerRun": "Lanzar una ejecución de la programación",
  "apiCall.cronjobs.readRun": "Leer una ejecución de la programación",
  "apiCall.cronjobs.listRecentRuns": "Listar las ejecuciones recientes",
  "apiCall.apps.list": "Listar las apps",
  "apiCall.apps.register": "Registrar una app",
  "apiCall.apps.read": "Leer una app",
  "apiCall.apps.preview": "Capturar la vista previa de la app",
  "apiCall.apps.update": "Actualizar la app",
  "apiCall.apps.delete": "Eliminar la app",
  "apiCall.apps.logs": "Leer los registros de la app",
  "apiCall.apps.start": "Arrancar la app",
  "apiCall.apps.stop": "Parar la app",
  "apiCall.apps.restart": "Reiniciar la app",
  "apiCall.skillUsage.read": "Leer el recuento de uso de habilidades",
  "apiCall.version.check": "Consultar la versión de isomux",
  "apiCall.storage.usage": "Consultar el uso de disco de la oficina",
  "apiCall.storage.prune": "Purgar el historial almacenado",
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
  "cards.userMessage.toRemoteBoss": "Al jefe remoto",
  "cards.userMessage.toRemoteBossNamed": 'Al jefe remoto "{name}"',
  "cards.userMessage.editAndBranch": "Editar y ramificar",
  "cards.thinking.label": "Pensando...",
  "cards.toolCall.input": "Entrada",
  "cards.toolCall.output": "Salida",
  "cards.toolCall.denied": "Denegado",
  "cards.toolCall.groupCount": "{count} llamadas a herramientas",
  "cards.toolResult.showMore": "Ver más",
  "cards.toolResult.showLess": "Ver menos",
  "cards.fileView.fullSize": "Tamaño completo",
  "cards.fileView.earlierAttachment":
    "El agente ha visto un archivo adjuntado antes en este chat. Haz clic para mostrarlo.",
  "cards.editRequest.open": "Abrir en el editor",
  "cards.editRequest.openHint": "Abrir {path} en el panel lateral del editor",
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
  "logView.abort": "Abortar",
  "logView.restartingSession": "Reiniciando la sesión...",
  "logView.queue.flushNow": "Enviar ahora",
  "logView.queue.flushHint":
    "Enviar ahora los mensajes en cola (interrumpe el turno actual)",
  "logView.queue.cancel": "Cancelar este mensaje en cola",
  "logView.interaction.current": "Actual",
  "logView.interaction.failed": "No se ha podido aplicar esa opción.",
  "logView.nav.agentTitle": "Ajustes del agente",
  "logView.nav.avatarTitle": "Ver el avatar",
  "logView.nav.editor": "Editor",
  "logView.nav.editorTitle": "Abrir el editor de archivos (Ctrl+E)",
  "logView.nav.terminalTitle": "Abrir la terminal (Ctrl+`)",
  "logView.backToOffice": "← Volver a la oficina",
  "logView.editTopic": "Haz clic para editar el tema",
  "logView.regenerateTopic": "Regenerar el tema a partir de la conversación",
  "logView.noHistoryToSummarize":
    "No hay historial de conversación que resumir",
  "logView.lastMessagePrefix": "↑ tú:",
  "logView.empty": "Envía un mensaje para empezar una conversación.",
  "logView.sendFailedBanner":
    "No se ha podido enviar - reconectando. Tu mensaje sigue en la caja; vuelve a intentarlo cuando desaparezca este aviso.",
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
  "logView.skills.origin.user": "habilidad de usuario",
  "logView.skills.origin.project": "habilidad de proyecto",
  "logView.skills.origin.plugin": "habilidad de plugin",
  "logView.skills.origin.isomux": "habilidad incluida en isomux",
  "logView.skills.origin.claude": "habilidad de claude",
  "logView.skills.origin.unknown": "habilidad",
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
  "logView.voice.httpsTitle": "La entrada de voz necesita HTTPS",
  "logView.voice.httpsStep1":
    "Activa HTTPS en tu <console>consola de administración de Tailscale</console> (página DNS), y luego ejecuta esto en el host (usa la terminal integrada):",
  "logView.voice.httpsStep2":
    "Visita la URL HTTPS que imprime Tailscale (p. ej. <url>{example}</url>).",
  "panels.resizer.label": "Cambiar el ancho del panel lateral",
  "panels.terminal.ready": "Lista",
  "panels.terminal.busy": "Ocupada: {process}",
  "panels.terminal.interrupt": "Interrumpir",
  "panels.terminal.interruptHint": "Interrumpir el comando en primer plano",
  "panels.terminal.restart": "Reiniciar",
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
  "cards.fileView.viewedFile": "Ha visto {file} (haz clic para mostrarlo)",
  "cards.fileView.viewedImages":
    "Ha visto {count} imágenes adjuntas (haz clic para mostrarlas)",
  "office.tabs.scrollLeft": "Desplazar las salas a la izquierda",
  "office.tabs.scrollRight": "Desplazar las salas a la derecha",
  "office.tabs.roomSettings": "Haz doble clic para la configuración de la sala",
  "office.tabs.closeEmptyRoom": "Cerrar la sala vacía",
  "office.tabs.newRoom": "Crear una sala nueva",
  "office.tabs.onlineUsers.one": "{count} usuario en línea",
  "office.tabs.onlineUsers.other": "{count} usuarios en línea",
  "office.zoom.in": "Acercar",
  "office.zoom.out": "Alejar",
  "office.zoom.reset": "Restablecer la vista (0)",
  "office.zoom.resetAria": "Restablecer la vista",
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
  "office.status.errShort": "error",
  "office.hints.tap": "TOCAR → abrir",
  "office.hints.longPress": "MANTENER PULSADO → acciones",
  "office.hints.pinch": "PELLIZCAR → zoom",
  "office.hints.dragZoomed": "ARRASTRAR (con zoom) → desplazar",
  "office.hints.click": "CLIC → abrir el agente",
  "office.hints.dragSwap":
    "ARRASTRAR → intercambiar escritorios o mover a la puerta",
  "office.hints.wheel": "RUEDA / +- → zoom",
  "office.hints.drag": "ARRASTRAR → desplazar",
  "office.hints.rightClick": "CLIC DERECHO → acciones",
  "office.hints.resetView": "0 → restablecer la vista",
  "office.pendingPrompt.permission": "permiso",
  "office.pendingPrompt.resume": "sesión",
  "office.pendingPrompt.model": "modelo",
  "office.pendingPrompt.effort": "esfuerzo",
  "office.pet.default": "Predeterminada",
  "contextMenu.editAgent": "Editar el agente...",
  "contextMenu.newConversation": "Conversación nueva",
  "contextMenu.newEngineConversation": "Conversación nueva de {engine}",
  "contextMenu.resume": "Reanudar",
  "common.current": "(actual)",
  "contextMenu.branched": "(ramificada)",
  "contextMenu.killAgent": "Eliminar el agente",
  "agentList.roomEmpty": "{room} está vacía",
  "agentList.thisRoom": "Esta sala",
  "agentList.noAgents": "Aún no hay agentes",
  "agentList.spawnHint": "Toca + para crear uno",
  "app.reconnecting": "Reconectando…",
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
  "apps.preview.notRunning":
    "Vista previa no disponible: la app no está en marcha.",
  "apps.preview.noBrowser":
    "Vista previa no disponible: Chrome no está instalado.",
  "apps.preview.unreachable": "Vista previa no disponible: la app no responde.",
  "apps.preview.busy": "La vista previa está ocupada. Inténtalo otra vez.",
  "apps.preview.failed": "No se pudo capturar la vista previa.",
  "apps.preview.queued": "Vista previa en cola…",
  "apps.preview.capturing": "Capturando la vista previa…",
  "apps.preview.retrying": "La vista previa está ocupada. Reintentando…",
  "apps.preview.tryAgain": "Intentar otra vez",
  "apps.preview.label": "Vista previa de la pantalla",
  "apps.hidePreviews": "Ocultar las vistas previas de las apps",
  "apps.showPreviews": "Mostrar las vistas previas de las apps",
  "apps.previewsOn": "vistas previas activadas",
  "apps.previewsOff": "vistas previas desactivadas",
  "apps.empty": "Aún no hay apps.",
  "apps.loadFailed": "No se pudieron cargar las apps.",
  "apps.deleteFailed": "No se pudo eliminar.",
  "apps.logReadFailed": "No se pudo leer el registro.",
  "apps.state.running": "en marcha",
  "apps.state.starting": "arrancando",
  "apps.state.stopped": "parada",
  "apps.state.failed": "fallida",
  "apps.state.unknown": "desconocido",
  "apps.meta.port": "puerto",
  "apps.meta.createdBy": "creada por",
  "apps.meta.owner": "propietario",
  "apps.openAgent": "Abrir el agente",
  "apps.commandIn": "en {cwd}",
  "apps.verb.start": "arrancar",
  "apps.verb.stop": "parar",
  "apps.verb.restart": "reiniciar",
  "apps.verbTitle.start": "Poner la app en marcha",
  "apps.verbTitle.stop": "Apagar la app (sus datos se conservan)",
  "apps.verbTitle.restart": "Parar la app y volver a arrancarla",
  "apps.showLog": "Mostrar la salida reciente de la app",
  "apps.hideLog": "ocultar el registro",
  "apps.log": "registro",
  "apps.removeTitle": "Quitar la app",
  "apps.delete": "eliminar",
  "apps.cancel": "cancelar",
  "apps.logEmpty": "Aún no hay nada en el registro.",
  "apps.confirmDelete":
    "¿Eliminar {name}? Su directorio de datos se conservará.",
  "tasks.status.open": "Abierta",
  "tasks.status.inProgress": "En curso",
  "tasks.status.backlog": "Pendiente",
  "tasks.status.done": "Hecha",
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
  "tasks.discardPrompt": "¿Descartar los cambios sin guardar?",
  "tasks.discard": "Descartar",
  "tasks.create": "Crear",
  "tasks.confirmDelete": "¿Confirmar?",
  "tasks.globalShort": "Global",
  "tasks.heading": "Tareas",
  "tasks.shownCount": "{count} a la vista",
  "tasks.quickAdd": "Añadir una tarea rápida…",
  "tasks.fileIn": "archivar en",
  "tasks.fileInTitle": "Las tareas nuevas se archivan en esta sala",
  "tasks.hintMobile": "Intro para añadir detalles",
  "tasks.hintDesktop": "Intro para añadir detalles · n para enfocar",
  "tasks.scopeTitle":
    "Filtrar las tareas y elegir dónde se archivan las nuevas",
  "tasks.allRooms": "Todas las salas",
  "tasks.filterActive": "Abiertas + en curso",
  "tasks.filterAll": "Todas",
  "tasks.filterAssignee": "Filtrar por responsable...",
  "tasks.searchPlaceholder": "Buscar tareas...",
  "tasks.col.status": "E",
  "tasks.col.priority": "P",
  "tasks.col.title": "TÍTULO",
  "tasks.col.assignee": "RESPONSABLE",
  "tasks.col.by": "POR",
  "tasks.col.age": "EDAD",
  "tasks.empty": "No hay tareas",
  "tasks.roomChipTitle": "Sala: {room}",
  "tasks.globalChipTitle": "Tarea global de la oficina",
  "tasks.createdFor": "{who} · para {target}",
  "office.noRooms.title": "No tienes ninguna sala asignada",
  "office.noRooms.create":
    "Usa el <strong>+</strong> de la barra de pestañas para crear tu propia sala.",
  "office.noRooms.visibility":
    "Las salas que creas solo las ven, de forma predeterminada, tú y los propietarios de la oficina (ellos pueden cambiarlo).",
  "office.noRooms.askOwner":
    "También puedes pedirle a un propietario que te añada a salas ya existentes.",
  "office.newAgent": "Agente nuevo",
  "apps.actionFailed.start": "No se pudo arrancar.",
  "apps.actionFailed.stop": "No se pudo parar.",
  "apps.actionFailed.restart": "No se pudo reiniciar.",
  "common.untitledConversation": "Conversación sin título",
  "schedules.human.daily": "Cada día a las {time}",
  "schedules.human.weekly": "Cada semana, {weekday} a las {time}",
  "schedules.human.everyMinutes": "Cada {minutes}m",
  "schedules.human.everyHours": "Cada {hours}h",
  "schedules.human.everyHoursMinutes": "Cada {hours}h{minutes}m",
  "schedules.nextRunIn": "en {duration}",

  "commands.clear.description": "Borrar el historial de la conversación",
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
  "commands.fork.description": "Ramificar la conversación en una sesión nueva",
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
  "commands.diff.description":
    "Ver los cambios sin confirmar en el cwd del agente (o pasa un directorio)",
  "commands.rewind.description":
    "Deshacer los cambios y revertir la conversación",
  "commands.checkpoint.description":
    "Deshacer los cambios y revertir la conversación",
  "commands.copy.description": "Copiar la última respuesta al portapapeles",
  "commands.files.description": "Listar los archivos que hay en el contexto",
  "commands.addDir.description": "Añadir más directorios de trabajo",
  "commands.btw.description": "Preguntar sin ensuciar el contexto principal",
  "commands.config.description": "Abrir la interfaz de ajustes",
  "commands.settings.description": "Abrir la interfaz de ajustes",
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
  "commands.color.description": "Cambiar el tema de color",
  "commands.vim.description": "Activar o desactivar los atajos de vim",
  "commands.terminalSetup.description":
    "Configurar la integración con el terminal",
  "commands.reloadPlugins.description": "Recargar los plugins instalados",
  "commands.reloadPlugins.message":
    "Para recargar los plugins, abre el terminal integrado (haz clic en el icono de terminal del escritorio del agente), ejecuta `claude` y escribe `/reload-plugins`.",
  "commands.tasks.description":
    "Listar o gestionar las tareas en segundo plano",
  "commands.bashes.description":
    "Listar o gestionar las tareas en segundo plano",
  "commands.doctor.description": "Comprobar el estado de la instalación",
  "commands.feedback.description": "Informar de errores a Anthropic",
  "commands.bug.description": "Informar de errores a Anthropic",
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
    "Gestionar plugins requiere la CLI de Claude Code directamente.\n\nPara gestionar los plugins:\n1. Abre el terminal integrado (haz clic en el icono de terminal del escritorio del agente)\n2. Ejecuta `claude`\n3. Escribe `/plugin` para explorar, instalar, activar o desactivar plugins\n\nComandos útiles:\n- `/plugin` - gestor interactivo de plugins (explorar, instalar, activar/desactivar)\n- `{addCommand}` - instalar un plugin por su nombre\n- `/plugin marketplace add owner/repo` - añadir un marketplace de la comunidad\n\nDespués de instalar un plugin, ejecuta `/reload-plugins` dentro de la sesión de Claude para activarlo.",
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
    "no está disponible de forma nativa; mira si la página de Programaciones o los mensajes programados te sirven",
  "commands.loremIpsum.description": "Generar texto de relleno",
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
  "commands.unsupported.notAvailable":
    "`/{name}` no está disponible en Isomux.",
  "commands.unsupported.unknownCommand":
    "Comando desconocido `/{name}`. Escribe `/help` para ver los comandos disponibles.",
  "commands.clear.failed": "No se pudo borrar la conversación: {error}",
  "commands.clear.done": "Conversación borrada.",
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
  "commands.help.tips": "**Consejos:**",
  "commands.help.tipAgents":
    "Los agentes pueden consultarse y enviarse mensajes entre ellos. Pídeselo con naturalidad o usa habilidades como `/second-opinion`, `/pair-programming`, etc.",
  "commands.help.tipQueue":
    'Puedes escribir mientras un agente está ocupado: los mensajes se encolan y salen cuando queda libre. Pulsa "Enviar ahora" o envía con Ctrl/Cmd+Enter para interrumpir y vaciar la cola al momento.',
  "commands.help.tipVoice":
    'Usa el dictado por voz para escribir más rápido. El atajo es ctrl+space. La puntuación dictada se escribe como puntuación: di "question mark", "comma", "period", "new line", y así.',
  "commands.help.tipPhoneVpn":
    "Isomux funciona en el móvil. Lo más fácil es conectarlo a la misma VPN (por ejemplo Tailscale, que es gratis) que la máquina donde se ejecuta.",
  "commands.help.tipInviteFunnel":
    "Cuando la oficina sea accesible desde fuera de tu VPN (por ejemplo con Tailscale Funnel; mira {url}), el propietario puede abrir Ajustes de usuario → Acceso y generar URL de invitación de un solo uso. Quien las recibe hace clic y entra: sin cuentas ni contraseñas.",
  "commands.help.tipPhoneOrigin": "Isomux funciona en el móvil: abre {origin}.",
  "commands.help.tipInvite":
    "El propietario puede abrir Ajustes de usuario → Acceso y generar URL de invitación de un solo uso. Quien las recibe hace clic y entra: sin cuentas ni contraseñas.",
  "commands.help.tipTerminal":
    "El terminal del panel lateral va bien para casos puntuales en los que necesitas ejecutar algo a mano, como un inicio de sesión.",
  "commands.help.tipHooks":
    "Isomux incluye hooks de seguridad previos a cada herramienta para los agentes de Claude, que evitan comandos destructivos. Los agentes de Codex no tienen hooks equivalentes.",
  "commands.help.commands": "**Comandos:**",
  "commands.help.aliasGroup": "{primary} (o {others})",
  "commands.help.skillsUser": "Habilidades de usuario",
  "commands.help.skillsProject": "Habilidades del proyecto",
  "commands.help.skillsPlugin": "Habilidades de plugins",
  "commands.help.skillsIsomux": "Habilidades de Isomux",
  "commands.help.skillsClaude": "Habilidades de Claude",
  "commands.resume.none": "No hay sesiones anteriores.",
  "commands.resume.header": "Retoma una conversación anterior:",
  "commands.resume.noOthers": "No hay otras sesiones que retomar.",
  "commands.resume.branched": "(ramificada)",
  "commands.model.openCodeUnsupported":
    "Abre los ajustes del agente para elegir un modelo de OpenCode conectado.",
  "commands.model.header": "Cambiar de modelo (actual: **{current}**):",
  "commands.effort.openCodeUnsupported":
    "OpenCode no expone controles de esfuerzo de razonamiento.",
  "commands.effort.header":
    "Cambiar el esfuerzo de razonamiento (actual: **{current}**):",
  "commands.isomuxAllHands.room": "**=== Sala {number} ===**",
  "commands.isomuxAllHands.me": "**(yo)**",
  "commands.isomuxAllHands.desk": "escritorio {number}",
  "commands.isomuxAllHands.topic": "Tema: {topic}",
  "commands.isomuxAllHands.footer":
    "Pregunta a tu agente si quieres saber más sobre cualquier agente o conversación.",
  "commands.isomuxSystemPrompt.header":
    "**Prompt de sistema completo** *(refleja los ajustes actuales; se aplica en la próxima conversación)*",
  "commands.isomuxCronjobSystemPrompt.usage": "Uso: {usage}",
  "commands.isomuxCronjobSystemPrompt.noSchedules":
    "No hay ninguna programación configurada.",
  "commands.isomuxCronjobSystemPrompt.known": "Programaciones conocidas:",
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
  "commands.isomuxEdit.notFound": "`{path}` no existe.",
  "commands.isomuxEdit.notFile": "`{path}` no es un archivo.",
  "commands.isomuxEdit.binary":
    "`{path}` es un archivo binario: el panel del editor solo admite texto.",
  "commands.isomuxEdit.tooLarge":
    "`{path}` ocupa {size}, demasiado para el panel del editor (el límite es 1 MB).",
  "commands.isomuxEdit.ioError": "No se pudo abrir `{path}`: {message}",
  "commands.isomuxDiff.notDirectory": "`{path}` no es un directorio.",
  "commands.isomuxDiff.notRepo": "`{path}` no es un repositorio de git.",
  "commands.isomuxDiff.gitError": "No se pudo ejecutar git diff en `{path}`:",
  "commands.isomuxDiff.clean":
    "El árbol de trabajo de `{path}` está limpio: no hay cambios sin confirmar.",
  "commands.usage.heading":
    "**Aquí no se muestran los límites del plan de suscripción.**",
  "commands.usage.intro":
    "Para consultar tu cuota de suscripción de Claude o de ChatGPT, abre el terminal integrado y:",
  "commands.usage.claude": "ejecuta `claude` y escribe `/usage`",
  "commands.usage.codex": "ejecuta `~/.isomux/bin/codex` y escribe `/status`",
  "commands.usage.office":
    "Para el gasto de tokens de la oficina (por agente, por sala y por programación), mira `/isomux-usage`.",
  "commands.usage.codexCardOmitted":
    "Se omite la tarjeta de `/status` de Codex: {error}",
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
  "systemEntries.conversationCleared": "Conversación borrada.",
  "systemEntries.newConversation": "Conversación nueva iniciada.",
  "systemEntries.agentStopped": "El agente se detuvo: {status}.",
  "systemEntries.backendFailure.stoppedDuringTurn":
    "El backend del agente se detuvo durante el turno. La conversación está guardada y se puede retomar.",
  "systemEntries.backendFailure.sigterm":
    "El backend del agente se terminó con SIGTERM (código de salida {code}). La causa más probable es la protección contra falta de memoria de esta máquina. La conversación está guardada y se puede retomar.",
  "systemEntries.backendFailure.sigkill":
    "El backend del agente se mató con SIGKILL (código de salida {code}). La causa más probable es la protección contra falta de memoria de esta máquina. La conversación está guardada y se puede retomar.",
  "systemEntries.backendFailure.signal":
    "El backend del agente se detuvo con la señal {signal} (código de salida {code}). La conversación está guardada y se puede retomar.",
  "systemEntries.agentReady":
    'El agente "{name}" está listo. Trabaja en {cwd}. Modo de permisos: {mode}.',
  "systemEntries.streamError": "Error de flujo: {error}",
  "systemEntries.startFailed": "No se pudo iniciar: {error}",
  "systemEntries.interrupted": "Agente interrumpido.",
  "systemEntries.wake.idle":
    "Se retomó tu sesión (se había liberado por inactividad para ahorrar memoria).",
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
  "systemEntries.codexInterruptFallback":
    "Codex no atendió la interrupción a tiempo; se pasa a una sesión nueva.",
  "systemEntries.deliveryStalled":
    "La entrega del mensaje se ha atascado; recuperando.",
  "systemEntries.freshSessionAfterRestoreFailure":
    "Se inició una sesión nueva (la anterior no se pudo restaurar).",
  "systemEntries.freshSessionBeforeFlush":
    "Se inició una sesión nueva antes de vaciar la cola de mensajes.",
  "systemEntries.flushStartFailed":
    "No se pudo iniciar la sesión para vaciar la cola: {error}",
  "systemEntries.restartingForSettings":
    "Se reinicia la sesión para aplicar los ajustes; los mensajes en cola saldrán después del reinicio.",
  "systemEntries.flushError": "Error al vaciar la cola: {error}",
  "systemEntries.genericError": "Error: {error}",
  "systemEntries.restoreOnStartupFailed":
    "No se pudo restaurar al arrancar: {error}\nEscribe /clear para empezar de cero, o /resume para elegir otra sesión.",
  "systemEntries.flushInterrupted":
    "El vaciado de la cola se interrumpió por un cambio de sesión; se reintentará.",
  "systemEntries.sessionStartFailed":
    "No se pudo iniciar la sesión: {error}\nEscribe /clear para empezar de cero, o /resume para elegir otra sesión.",
  "systemEntries.queueFailed": "No se pudo encolar el mensaje: {error}",
  "systemEntries.queueCleared.notConfigured.one":
    "Se descartó {count} mensaje en cola porque el backend no está configurado.",
  "systemEntries.queueCleared.notConfigured.other":
    "Se descartaron {count} mensajes en cola porque el backend no está configurado.",
  "systemEntries.queueCleared.switching.one":
    "Se descartó {count} mensaje en cola al cambiar a otra sesión.",
  "systemEntries.queueCleared.switching.other":
    "Se descartaron {count} mensajes en cola al cambiar a otra sesión.",
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
  "systemEntries.permissionOutcome.turnStopped":
    "Cancelado al detenerse el turno",
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
  "systemEntries.resumeFailed": "No se pudo retomar: {error}",
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
  "systemEntries.signInRequired":
    "{provider} no pudo ejecutar este mensaje porque no ha iniciado sesión. Inicia sesión abajo para continuar.",
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
    "_El desglose por agente y las rutas son solo para el propietario._",
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
    "_Aquí no se borra nada automáticamente. Las transcripciones y los adjuntos solo se eliminan cuando el propietario lo pide._",
  "storageReport.unknownSize": "tamaño desconocido",
};
