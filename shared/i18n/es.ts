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
  "common.copied": "Copiado",
  "common.copy": "Copiar",
  "common.device": "Dispositivo",
  "common.discard": "Descartar",
  "common.name": "Nombre",
  "common.noRooms": "Aún no hay salas.",
  "common.prefix": "Prefijo",
  "common.revoke": "Revocar",
  "common.role": "Rol",
  "common.rooms": "Salas",
  "common.signOut": "Cerrar sesión",
  "common.user": "Usuario",

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
  "settings.profile.avatar": "Avatar",
  "settings.profile.avatarHint":
    "(tu fantasma en la escena de la oficina; los demás usuarios lo ven junto al agente que estás viendo)",
  "settings.profile.discardPrompt": "¿Descartar los cambios sin guardar?",
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

  "settings.access.none": "Ninguna.",
  "settings.access.expired": "caducada",
  "settings.access.localTime": "{time} local",
  "settings.access.inviteUrl": "URL de invitación",
  "settings.access.copyUrl": "Copiar la URL",
  "settings.access.urlCopied": "¡Copiada!",
  "settings.access.clipboardBlocked":
    "Portapapeles bloqueado. La URL de arriba está seleccionada - cópiala a mano.",
  "settings.access.sendUrl":
    "Envía esta URL a la persona invitada. Es de un solo uso: al abrirla en su dispositivo, entra. La URL se muestra una vez - cópiala ahora.",
  "settings.access.dismiss": "Cerrar",

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
  "settings.apiTokens.days": "{count} días",
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
};
