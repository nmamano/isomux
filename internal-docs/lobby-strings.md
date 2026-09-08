> Superseded behavior, 2026-09-08: the receptionist is now an ordinary agent
> created from the Isomux Receptionist profile. Name, cwd, kill, move, prompt and
> token use the normal paths. Its initial cwd is ~; the old directory is left
> on disk. The first owner is its boss. Knowledge and office guidance render at
> spawn into custom instructions. The canonical lobby room has one slot and
> persists in agents.json. Any agent can occupy it; an empty lobby stays empty
> across restarts. The former locks, restricted token, dedicated prompt and
> directory claims below describe the previous implementation only.

# Lobby copy inventory

Catalog text, 2026-09-08. Placeholders remain literal; dynamic names and errors are data. Internal editor copy is excluded.

## New catalog entries

| Key | English | Spanish | Catalan |
|---|---|---|---|
| `apiCall.membersChat.delete` | `Delete members chat message` | `Eliminar un mensaje del chat de miembros` | `Eliminar un missatge del xat de membres` |
| `apiCall.membersChat.edit` | `Edit members chat message` | `Editar un mensaje del chat de miembros` | `Editar un missatge del xat de membres` |
| `apiCall.membersChat.markRead` | `Mark members chat read` | `Marcar el chat de miembros como leído` | `Marcar el xat de membres com a llegit` |
| `apiCall.membersChat.post` | `Post to members chat` | `Publicar en el chat de miembros` | `Publicar al xat de membres` |
| `apiCall.membersChat.read` | `Read members chat` | `Leer el chat de miembros` | `Llegir el xat de membres` |
| `common.lobby` | `Lobby` | `Vestíbulo` | `Vestíbul` |
| `lobby.askHint` | `Ask about Isomux or this office` | `Pregunta sobre Isomux o esta oficina` | `Pregunta sobre Isomux o aquesta oficina` |
| `lobby.directory` | `DIRECTORY` | `DIRECTORIO` | `DIRECTORI` |
| `lobby.employeeLine1` | `EMPLOYEE OF` | `EMPLEADO` | `EMPLEAT` |
| `lobby.employeeLine2` | `THE MINUTE` | `DEL MINUTO` | `DEL MINUT` |
| `lobby.identityLocked` | `The receptionist keeps its name and working directory.` | `El recepcionista conserva su nombre y su directorio de trabajo.` | `El recepcionista conserva el nom i el directori de treball.` |
| `lobby.officeFallback` | `the office` | `la oficina` | `l'oficina` |
| `lobby.openChat` | `{name} - click to open the chat` | `{name} - haz clic para abrir el chat` | `{name} - fes clic per obrir el xat` |
| `lobby.poster` | `THE OFFICE` | `LA OFICINA` | `L'OFICINA` |
| `lobby.receptionistName` | `Receptionist` | `Recepcionista` | `Recepcionista` |
| `lobby.receptionistNameLocked` | `The receptionist keeps its name.` | `El recepcionista conserva su nombre.` | `El recepcionista conserva el seu nom.` |
| `lobby.welcome` | `WELCOME` | `BIENVENIDOS` | `BENVINGUTS` |
| `demo.receptionistReply` | `Welcome to the lobby. In a real office I answer questions about Isomux and about this office. This is a demo, so nothing was sent to a model.` | `Bienvenidos al vestíbulo. En una oficina real respondo preguntas sobre Isomux y sobre esta oficina. Esto es una demo, así que no se ha enviado nada a un modelo.` | `Benvinguts al vestíbul. En una oficina real responc preguntes sobre Isomux i sobre aquesta oficina. Això és una demo, així que no s'ha enviat res a cap model.` |
| `membersChat.authorAgent` | `{name} · agent` | `{name} · agente` | `{name} · agent` |
| `membersChat.authorApi` | `{name} · API token` | `{name} · token de API` | `{name} · token d'API` |
| `membersChat.authorApiDevice` | `{name} · API token "{device}"` | `{name} · token de API "{device}"` | `{name} · token d'API "{device}"` |
| `membersChat.deleteAgain` | `Click again to delete` | `Haz clic de nuevo para eliminar` | `Fes clic de nou per eliminar` |
| `membersChat.deleteFailed` | `Could not delete` | `No se pudo eliminar` | `No s'ha pogut eliminar` |
| `membersChat.editFailed` | `Could not edit` | `No se pudo editar` | `No s'ha pogut editar` |
| `membersChat.edited` | ` · edited` | ` · editado` | ` · editat` |
| `membersChat.empty` | `Nothing here yet. Only people see this chat.` | `Todavía no hay nada. Solo las personas ven este chat.` | `Encara no hi ha res. Només les persones veuen aquest xat.` |
| `membersChat.loadFailed` | `Could not load the chat` | `No se pudo cargar el chat` | `No s'ha pogut carregar el xat` |
| `membersChat.loadOlder` | `Load older` | `Cargar anteriores` | `Carrega anteriors` |
| `membersChat.loadingOlder` | `Loading older…` | `Cargando mensajes anteriores…` | `Carregant missatges anteriors…` |
| `membersChat.olderFailed` | `Could not load older` | `No se pudieron cargar mensajes anteriores` | `No s'han pogut carregar missatges anteriors` |
| `membersChat.online` | `{count} online` | `{count} en línea` | `{count} en línia` |
| `membersChat.placeholder` | `Message the members…` | `Escribe a los miembros…` | `Escriu als membres…` |
| `membersChat.sendFailed` | `Could not send` | `No se pudo enviar` | `No s'ha pogut enviar` |
| `membersChat.sure` | `sure?` | `¿seguro?` | `segur?` |
| `membersChat.title` | `Members chat` | `Chat de miembros` | `Xat de membres` |
| `membersChat.uploadFailed` | `upload failed` | `error al subir` | `error en pujar` |
| `membersChat.uploadStatus` | `Upload failed ({status})` | `Error al subir ({status})` | `Error en pujar ({status})` |
| `membersChat.uploading` | `uploading…` | `subiendo…` | `pujant…` |

## Inherited copy in the reused components

These entries are unchanged. The shared page components keep their existing copy when opened from the lobby.

| Key | English | Spanish | Catalan |
|---|---|---|---|
| `agentList.noAgents` | `No agents yet` | `Aún no hay agentes` | `Encara no hi ha agents` |
| `agentList.roomEmpty` | `{room} is empty` | `{room} está vacía` | `{room} és buida` |
| `agentList.spawnHint` | `Tap + to spawn one` | `Toca + para crear uno` | `Toca + per crear-ne un` |
| `agentList.thisRoom` | `This room` | `Esta sala` | `Aquesta sala` |
| `apps.actionFailed.restart` | `Could not restart.` | `No se pudo reiniciar.` | `No s'ha pogut reiniciar.` |
| `apps.actionFailed.start` | `Could not start.` | `No se pudo arrancar.` | `No s'ha pogut engegar.` |
| `apps.actionFailed.stop` | `Could not stop.` | `No se pudo parar.` | `No s'ha pogut aturar.` |
| `apps.cancel` | `cancel` | `cancelar` | `cancel·la` |
| `apps.commandIn` | `in {cwd}` | `en {cwd}` | `a {cwd}` |
| `apps.confirmDelete` | `Delete {name}? Its data directory will be kept.` | `¿Eliminar {name}? Su directorio de datos se conservará.` | `Vols eliminar {name}? El seu directori de dades es conservarà.` |
| `apps.delete` | `delete` | `eliminar` | `elimina` |
| `apps.deleteFailed` | `Could not delete.` | `No se pudo eliminar.` | `No s'ha pogut eliminar.` |
| `apps.empty` | `No apps yet.` | `Aún no hay apps.` | `Encara no hi ha apps.` |
| `apps.hideLog` | `hide log` | `ocultar el registro` | `amaga el registre` |
| `apps.hidePreviews` | `Hide app previews` | `Ocultar las vistas previas de las apps` | `Amaga les vistes prèvies de les apps` |
| `apps.loadFailed` | `Could not load apps.` | `No se pudieron cargar las apps.` | `No s'han pogut carregar les apps.` |
| `apps.log` | `log` | `registro` | `registre` |
| `apps.logEmpty` | `Nothing in the log yet.` | `Aún no hay nada en el registro.` | `Encara no hi ha res al registre.` |
| `apps.logReadFailed` | `Could not read the log.` | `No se pudo leer el registro.` | `No s'ha pogut llegir el registre.` |
| `apps.meta.createdBy` | `created by` | `creada por` | `creada per` |
| `apps.meta.owner` | `owner` | `propietario` | `propietari` |
| `apps.meta.port` | `port` | `puerto` | `port` |
| `apps.openAgent` | `Open the agent` | `Abrir el agente` | `Obre l'agent` |
| `apps.openApp` | `Open app` | `Abrir la app` | `Obre l'app` |
| `apps.openOnNetwork` | `Open on this network` | `Abrir en esta red` | `Obre en aquesta xarxa` |
| `apps.preview.busy` | `Preview is busy. Try again.` | `La vista previa está ocupada. Inténtalo otra vez.` | `La vista prèvia està ocupada. Torna-ho a provar.` |
| `apps.preview.capturing` | `Capturing preview…` | `Capturando la vista previa…` | `S'està capturant la vista prèvia…` |
| `apps.preview.failed` | `Preview could not be captured.` | `No se pudo capturar la vista previa.` | `No s'ha pogut capturar la vista prèvia.` |
| `apps.preview.label` | `Screenshot preview` | `Vista previa de la pantalla` | `Vista prèvia de la pantalla` |
| `apps.preview.noBrowser` | `Preview unavailable: Chrome is not installed.` | `Vista previa no disponible: Chrome no está instalado.` | `Vista prèvia no disponible: el Chrome no està instal·lat.` |
| `apps.preview.notRunning` | `Preview unavailable: app is not running.` | `Vista previa no disponible: la app no está en marcha.` | `Vista prèvia no disponible: l'app no està en marxa.` |
| `apps.preview.queued` | `Preview queued…` | `Vista previa en cola…` | `Vista prèvia en cua…` |
| `apps.preview.retrying` | `Preview is busy. Retrying…` | `La vista previa está ocupada. Reintentando…` | `La vista prèvia està ocupada. S'està reintentant…` |
| `apps.preview.tryAgain` | `Try again` | `Intentar otra vez` | `Torna-ho a provar` |
| `apps.preview.unreachable` | `Preview unavailable: the app is not responding.` | `Vista previa no disponible: la app no responde.` | `Vista prèvia no disponible: l'app no respon.` |
| `apps.previewsOff` | `previews off` | `vistas previas desactivadas` | `vistes prèvies desactivades` |
| `apps.previewsOn` | `previews on` | `vistas previas activadas` | `vistes prèvies activades` |
| `apps.removeTitle` | `Remove the app` | `Quitar la app` | `Treu l'app` |
| `apps.showLog` | `Show the app's recent output` | `Mostrar la salida reciente de la app` | `Mostra la sortida recent de l'app` |
| `apps.showPreviews` | `Show app previews` | `Mostrar las vistas previas de las apps` | `Mostra les vistes prèvies de les apps` |
| `apps.state.failed` | `failed` | `fallida` | `fallida` |
| `apps.state.running` | `running` | `en marcha` | `en marxa` |
| `apps.state.starting` | `starting` | `arrancando` | `s'està engegant` |
| `apps.state.stopped` | `stopped` | `parada` | `aturada` |
| `apps.state.unknown` | `unknown` | `desconocido` | `desconegut` |
| `apps.verb.restart` | `restart` | `reiniciar` | `reinicia` |
| `apps.verb.start` | `start` | `arrancar` | `engega` |
| `apps.verb.stop` | `stop` | `parar` | `atura` |
| `apps.verbTitle.restart` | `Stop the app and start it again` | `Parar la app y volver a arrancarla` | `Atura l'app i torna-la a engegar` |
| `apps.verbTitle.start` | `Run the app` | `Poner la app en marcha` | `Posa l'app en marxa` |
| `apps.verbTitle.stop` | `Shut the app down (its data is kept)` | `Apagar la app (sus datos se conservan)` | `Atura l'app (les seves dades es conserven)` |
| `cards.fileView.earlierAttachment` | `The agent viewed a file attached earlier in this chat. Click to show it.` | `El agente ha visto un archivo adjuntado antes en este chat. Haz clic para mostrarlo.` | `L'agent ha vist un fitxer adjuntat abans en aquest xat. Fes clic per mostrar-lo.` |
| `cards.fileView.fullSize` | `Full size` | `Tamaño completo` | `Mida completa` |
| `cards.fileView.viewedFile` | `Viewed {file} (click to show)` | `Ha visto {file} (haz clic para mostrarlo)` | `Ha vist {file} (fes clic per mostrar-lo)` |
| `cards.fileView.viewedImages` | `Viewed {count} attached images (click to show)` | `Ha visto {count} imágenes adjuntas (haz clic para mostrarlas)` | `Ha vist {count} imatges adjuntes (fes clic per mostrar-les)` |
| `cards.subagent.pill` | `subagent` | `subagente` | `subagent` |
| `cards.subagent.pillTyped` | `subagent · {type}` | `subagente · {type}` | `subagent · {type}` |
| `cards.subagent.title` | `Subagent` | `Subagente` | `Subagent` |
| `cards.subagent.titleDescribed` | `Subagent: {description}` | `Subagente: {description}` | `Subagent: {description}` |
| `cards.subagent.titleTyped` | `Subagent ({type})` | `Subagente ({type})` | `Subagent ({type})` |
| `cards.subagent.titleTypedDescribed` | `Subagent ({type}): {description}` | `Subagente ({type}): {description}` | `Subagent ({type}): {description}` |
| `cards.terminalCommand.copy` | `Copy to terminal` | `Copiar en la terminal` | `Copia a la terminal` |
| `cards.terminalCommand.copyHint` | `Open the terminal panel and type this command at the prompt (not auto-executed)` | `Abre el panel de la terminal y escribe este comando en el prompt (no se ejecuta solo)` | `Obre el plafó de la terminal i escriu aquesta ordre al prompt (no s'executa sola)` |
| `cards.thinking.label` | `Thinking...` | `Pensando...` | `Pensant...` |
| `cards.tool.morePaths` | `{path} +{count} more` | `{path} +{count} más` | `{path} +{count} més` |
| `cards.tool.noOutput` | `(no output)` | `(sin salida)` | `(sense sortida)` |
| `cards.toolCall.denied` | `Denied` | `Denegado` | `Denegat` |
| `cards.toolCall.groupCount` | `{count} tool calls` | `{count} llamadas a herramientas` | `{count} crides a eines` |
| `cards.toolCall.input` | `Input` | `Entrada` | `Entrada` |
| `cards.toolCall.output` | `Output` | `Salida` | `Sortida` |
| `cards.toolResult.showLess` | `Show less` | `Ver menos` | `Mostra'n menys` |
| `cards.toolResult.showMore` | `Show more` | `Ver más` | `Mostra'n més` |
| `cards.userMessage.editAndBranch` | `Edit & branch` | `Editar y ramificar` | `Edita i ramifica` |
| `cards.userMessage.toRemoteBoss` | `To remote boss` | `Al jefe remoto` | `Al cap remot` |
| `cards.userMessage.toRemoteBossNamed` | `To remote boss "{name}"` | `Al jefe remoto "{name}"` | `Al cap remot "{name}"` |
| `common.apps` | `Apps` | `Apps` | `Apps` |
| `common.back` | `Back` | `Atrás` | `Enrere` |
| `common.cancel` | `Cancel` | `Cancelar` | `Cancel·la` |
| `common.changeTheme` | `Change theme` | `Cambiar el tema` | `Canvia el tema` |
| `common.confirmQuestion` | `Confirm?` | `¿Confirmar?` | `Ho confirmes?` |
| `common.delete` | `Delete` | `Eliminar` | `Elimina` |
| `common.discard` | `Discard` | `Descartar` | `Descarta` |
| `common.discardPrompt` | `Discard unsaved changes?` | `¿Descartar los cambios sin guardar?` | `Vols descartar els canvis sense desar?` |
| `common.edit` | `Edit` | `Editar` | `Edita` |
| `common.field.approvalPolicy` | `Approval Policy` | `Política de aprobación` | `Política d'aprovació` |
| `common.field.effort` | `Thinking Effort` | `Esfuerzo de razonamiento` | `Esforç de raonament` |
| `common.field.engine` | `Engine` | `Motor` | `Motor` |
| `common.field.model` | `Model` | `Modelo` | `Model` |
| `common.field.permissionMode` | `Permission Mode` | `Modo de permisos` | `Mode de permisos` |
| `common.field.sandbox` | `Sandbox` | `Sandbox` | `Sandbox` |
| `common.field.workingDirectory` | `Working Directory` | `Directorio de trabajo` | `Directori de treball` |
| `common.justNow` | `just now` | `ahora mismo` | `ara mateix` |
| `common.loading` | `Loading…` | `Cargando…` | `Carregant…` |
| `common.loadingDots` | `Loading...` | `Cargando...` | `Carregant...` |
| `common.loadingMemory` | `Loading memory…` | `Cargando la memoria…` | `Carregant la memòria…` |
| `common.memory` | `Memory` | `Memoria` | `Memòria` |
| `common.model.checkFailed` | `The available models could not be checked. Reopen this dialog to try again.` | `No se han podido comprobar los modelos disponibles. Vuelve a abrir este diálogo para intentarlo de nuevo.` | `No s'han pogut comprovar els models disponibles. Torna a obrir aquest diàleg per provar-ho de nou.` |
| `common.model.currentIs` | `Current model: {model}.` | `Modelo actual: {model}.` | `Model actual: {model}.` |
| `common.model.currentOption` | `Current model` | `Modelo actual` | `Model actual` |
| `common.model.loadFailed` | `Failed to load models` | `No se pudieron cargar los modelos` | `No s'han pogut carregar els models` |
| `common.model.loading` | `Loading available models…` | `Cargando los modelos disponibles…` | `Carregant els models disponibles…` |
| `common.model.noneConnected` | `OpenCode has no connected provider models for this environment.` | `OpenCode no tiene modelos de ningún proveedor conectado para este entorno.` | `OpenCode no té models de cap proveïdor connectat per a aquest entorn.` |
| `common.model.notOffered` | `This login does not offer it. Choose an available model.` | `Esta cuenta no lo ofrece. Elige un modelo disponible.` | `Aquest compte no l'ofereix. Tria un model disponible.` |
| `common.model.selectConnected` | `Select a connected OpenCode model before saving.` | `Elige un modelo de OpenCode conectado antes de guardar.` | `Tria un model d'OpenCode connectat abans de desar.` |
| `common.model.startingOpenCode` | `OpenCode is starting. Loading available models…` | `OpenCode se está iniciando. Cargando los modelos disponibles…` | `OpenCode s'està iniciant. Carregant els models disponibles…` |
| `common.name` | `Name` | `Nombre` | `Nom` |
| `common.nextConversation` | `Changes take effect on next conversation.` | `Los cambios se aplican en la siguiente conversación.` | `Els canvis s'apliquen a la conversa següent.` |
| `common.permission.claudeBypass` | `Bypass (auto-approve all)` | `Omitir permisos (se aprueba todo automáticamente)` | `Ometre els permisos (s'aprova tot automàticament)` |
| `common.permission.codexNever` | `Never ask (use sandbox-only)` | `No preguntar nunca (solo el sandbox)` | `No preguntar mai (només el sandbox)` |
| `common.roomFallback` | `Room {number}` | `Sala {number}` | `Sala {number}` |
| `common.rules` | `Rules` | `Reglas` | `Regles` |
| `common.sandbox.dangerFullAccess` | `Danger: full access (no sandbox)` | `Peligro: acceso total (sin sandbox)` | `Perill: accés total (sense sandbox)` |
| `common.sandbox.readOnly` | `Read-only (model can read, never write)` | `Solo lectura (el modelo puede leer, nunca escribir)` | `Només lectura (el model pot llegir, mai escriure)` |
| `common.sandbox.workspaceWrite` | `Workspace write (write inside cwd only)` | `Escritura en el espacio de trabajo (solo dentro del cwd)` | `Escriptura a l'espai de treball (només dins del cwd)` |
| `common.save` | `Save` | `Guardar` | `Desa` |
| `common.saveFailed` | `Save failed` | `No se pudo guardar` | `No s'ha pogut desar` |
| `common.saving` | `Saving…` | `Guardando…` | `Desant…` |
| `common.schedule` | `Schedule` | `Programación` | `Programació` |
| `common.schedules` | `Schedules` | `Programaciones` | `Programacions` |
| `common.send` | `Send` | `Enviar` | `Envia` |
| `common.sender.agent` | `{name} · agent` | `{name} · agente` | `{name} · agent` |
| `common.sender.agentInRoom` | `{name} · agent · Room "{room}"` | `{name} · agente · Sala "{room}"` | `{name} · agent · Sala "{room}"` |
| `common.sender.app` | `{name} · app` | `{name} · app` | `{name} · app` |
| `common.sender.cronjob` | `{name} · schedule` | `{name} · programación` | `{name} · programació` |
| `common.settings` | `Settings` | `Ajustes` | `Configuració` |
| `common.tasks` | `Tasks` | `Tareas` | `Tasques` |
| `common.theme` | `Theme` | `Tema` | `Tema` |
| `common.unread` | `unread` | `sin leer` | `sense llegir` |
| `common.you` | `You` | `Tú` | `Tu` |
| `dialogs.agent.accessory` | `Accessory` | `Accesorio` | `Accessori` |
| `dialogs.agent.accessory.bowTie` | `Bow Tie` | `Pajarita` | `Corbatí` |
| `dialogs.agent.accessory.earrings` | `Earrings` | `Pendientes` | `Arracades` |
| `dialogs.agent.accessory.glasses` | `Glasses` | `Gafas` | `Ulleres` |
| `dialogs.agent.accessory.headphones` | `Headphones` | `Auriculares` | `Auriculars` |
| `dialogs.agent.accessory.none` | `None` | `Ninguno` | `Cap` |
| `dialogs.agent.accessory.tie` | `Tie` | `Corbata` | `Corbata` |
| `dialogs.agent.appearance` | `Appearance` | `Aspecto` | `Aspecte` |
| `dialogs.agent.beard` | `Beard` | `Barba` | `Barba` |
| `dialogs.agent.beard.full` | `Full` | `Poblada` | `Poblada` |
| `dialogs.agent.beard.goatee` | `Goatee` | `Perilla` | `Perilla` |
| `dialogs.agent.beard.mustache` | `Mustache` | `Bigote` | `Bigoti` |
| `dialogs.agent.beard.none` | `None` | `Ninguna` | `Cap` |
| `dialogs.agent.beard.stubble` | `Stubble` | `Incipiente` | `Incipient` |
| `dialogs.agent.blank` | `Blank` | `En blanco` | `En blanc` |
| `dialogs.agent.blankHint` | `Set up the agent yourself.` | `Configura el agente tú mismo.` | `Configura l'agent tu mateix.` |
| `dialogs.agent.customInstructions` | `Custom Instructions` | `Instrucciones personalizadas` | `Instruccions personalitzades` |
| `dialogs.agent.customInstructionsHint` | `Personal system prompt for this agent. Run /isomux-system-prompt in a chat to see the agent's full system prompt.` | `Prompt de sistema personal para este agente. Ejecuta /isomux-system-prompt en un chat para ver el prompt de sistema completo del agente.` | `Prompt de sistema personal per a aquest agent. Executa /isomux-system-prompt en un xat per veure el prompt de sistema complet de l'agent.` |
| `dialogs.agent.customInstructionsPlaceholder` | `e.g. "You are a backend specialist. Always write tests."` | `p. ej. "Eres un especialista en backend. Escribe siempre tests."` | `p. ex. "Ets un especialista en backend. Escriu sempre tests."` |
| `dialogs.agent.desk` | `Desk #{desk}` | `Escritorio #{desk}` | `Escriptori #{desk}` |
| `dialogs.agent.engineSwitchHint` | `Switching to {engine} starts a new conversation. The current one stays in this agent's resume history.` | `Cambiar a {engine} empieza una conversación nueva. La actual se queda en el historial de sesiones de este agente.` | `Canviar a {engine} comença una conversa nova. L'actual es queda a l'historial de sessions d'aquest agent.` |
| `dialogs.agent.hairColor` | `Hair Color` | `Color del pelo` | `Color del cabell` |
| `dialogs.agent.hairStyle` | `Hair Style` | `Peinado` | `Pentinat` |
| `dialogs.agent.hairStyle.bald` | `Bald` | `Calvo` | `Calb` |
| `dialogs.agent.hairStyle.bun` | `Bun` | `Moño` | `Monyo` |
| `dialogs.agent.hairStyle.curly` | `Curly` | `Rizado` | `Arrissat` |
| `dialogs.agent.hairStyle.long` | `Long` | `Largo` | `Llarg` |
| `dialogs.agent.hairStyle.pigtails` | `Pigtails` | `Coletas` | `Cues` |
| `dialogs.agent.hairStyle.ponytail` | `Ponytail` | `Coleta` | `Cua` |
| `dialogs.agent.hairStyle.short` | `Short` | `Corto` | `Curt` |
| `dialogs.agent.hat` | `Hat` | `Gorro` | `Barret` |
| `dialogs.agent.hat.beanie` | `Beanie` | `Gorro de lana` | `Gorro de llana` |
| `dialogs.agent.hat.bow` | `Hair Bow` | `Lazo` | `Llaç` |
| `dialogs.agent.hat.cap` | `Cap` | `Gorra` | `Gorra` |
| `dialogs.agent.hat.headband` | `Headband` | `Cinta` | `Cinta` |
| `dialogs.agent.hat.none` | `None` | `Ninguno` | `Cap` |
| `dialogs.agent.invalidDirectory` | `Invalid directory` | `Directorio no válido` | `Directori no vàlid` |
| `dialogs.agent.manager` | `Manager` | `Responsable` | `Responsable` |
| `dialogs.agent.managerHint` | `Locked to the spawning user. Controls which personal variables load on each session (see Settings → You → Individual connections).` | `Vinculado al usuario que lo crea. Determina qué variables personales se cargan en cada sesión (mira Ajustes → Tú → Conexiones individuales).` | `Vinculat a l'usuari que el crea. Determina quines variables personals es carreguen a cada sessió (mira Configuració → Tu → Connexions individuals).` |
| `dialogs.agent.managerNoUser` | `(no user assigned)` | `(sin usuario asignado)` | `(cap usuari assignat)` |
| `dialogs.agent.managerTitle` | `Set at spawn - manager cannot be changed after the agent is created.` | `Se fija al crear el agente - el responsable no se puede cambiar después.` | `Es fixa en crear l'agent - el responsable no es pot canviar després.` |
| `dialogs.agent.managerUnowned` | `(unowned)` | `(sin propietario)` | `(sense propietari)` |
| `dialogs.agent.memoryHint` | `(durable facts for this agent; raw lines; {size} / {cap})` | `(hechos duraderos de este agente; líneas en bruto; {size} / {cap})` | `(fets duradors d'aquest agent; línies en brut; {size} / {cap})` |
| `dialogs.agent.memoryPlaceholder` | `Some memory relevant to this agent` | `Alguna memoria relevante para este agente` | `Alguna memòria rellevant per a aquest agent` |
| `dialogs.agent.memoryTitle` | `Agent Memory` | `Memoria del agente` | `Memòria de l'agent` |
| `dialogs.agent.modelTier.free` | `Free (the provider may use traffic for training)` | `Gratis (el proveedor puede usar el tráfico para entrenar)` | `Gratis (el proveïdor pot fer servir el trànsit per entrenar)` |
| `dialogs.agent.modelTier.payg` | `Pay-as-you-go (OpenCode credits)` | `Pago por uso (créditos de OpenCode)` | `Pagament per ús (crèdits d'OpenCode)` |
| `dialogs.agent.modelTier.subscription` | `Subscription (OpenCode Go)` | `Suscripción (OpenCode Go)` | `Subscripció (OpenCode Go)` |
| `dialogs.agent.moveToRoom` | `Move to Room` | `Mover a la sala` | `Moure a la sala` |
| `dialogs.agent.optional` | `(optional)` | `(opcional)` | `(opcional)` |
| `dialogs.agent.permission.ask` | `Ask` | `Preguntar` | `Preguntar` |
| `dialogs.agent.permission.bypassAll` | `Bypass all permissions` | `Omitir todos los permisos` | `Ometre tots els permisos` |
| `dialogs.agent.permission.claudeAcceptEdits` | `Accept Edits (auto-approve file changes)` | `Aceptar ediciones (aprobar los cambios en archivos)` | `Acceptar les edicions (aprovar els canvis en fitxers)` |
| `dialogs.agent.permission.claudeAuto` | `Auto (classifier auto-approves safe actions)` | `Auto (un clasificador aprueba las acciones seguras)` | `Auto (un classificador aprova les accions segures)` |
| `dialogs.agent.permission.claudeDefault` | `Default (ask for everything)` | `Por defecto (preguntar para todo)` | `Per defecte (preguntar per a tot)` |
| `dialogs.agent.permission.codexOnRequest` | `On request (model asks when needed)` | `A petición (el modelo pregunta cuando lo necesita)` | `A petició (el model pregunta quan ho necessita)` |
| `dialogs.agent.permission.codexUntrusted` | `Untrusted (ask on every tool)` | `No fiable (preguntar en cada herramienta)` | `No fiable (preguntar a cada eina)` |
| `dialogs.agent.privileged` | `Privileged operator access` | `Acceso de operador con privilegios` | `Accés d'operador amb privilegis` |
| `dialogs.agent.privilegedHint` | `Lets this agent drive other agents' sessions (resume, new conversation, send-now) and manage its own cronjobs, with the spawning user's room-scoped permissions. It still acts as the agent, never as the user.` | `Permite a este agente dirigir las sesiones de otros agentes (reanudar, conversación nueva, enviar ahora) y gestionar sus propios cronjobs, con los permisos por sala del usuario que lo creó. Sigue actuando como el agente, nunca como el usuario.` | `Permet a aquest agent dirigir les sessions d'altres agents (reprendre, conversa nova, enviar ara) i gestionar els seus propis cronjobs, amb els permisos per sala de l'usuari que el va crear. Continua actuant com l'agent, mai com l'usuari.` |
| `dialogs.agent.privilegedRestart` | `Saving restarts the agent's session.` | `Al guardar se reinicia la sesión del agente.` | `En desar es reinicia la sessió de l'agent.` |
| `dialogs.agent.randomize` | `Randomize` | `Elegir al azar` | `Tria a l'atzar` |
| `dialogs.agent.recent` | `Recent` | `Recientes` | `Recents` |
| `dialogs.agent.revive` | `Revive a killed agent` | `Reactivar un agente detenido` | `Reactiva un agent aturat` |
| `dialogs.agent.reviveFailed` | `Revive failed` | `No se pudo reactivar` | `No s'ha pogut reactivar` |
| `dialogs.agent.reviving` | `Reviving…` | `Reactivando…` | `Reactivant…` |
| `dialogs.agent.shirt` | `Shirt` | `Camiseta` | `Samarreta` |
| `dialogs.agent.skin` | `Skin` | `Piel` | `Pell` |
| `dialogs.agent.spawn` | `Spawn` | `Crear` | `Crea` |
| `dialogs.agent.staleInstructions` | `Custom instructions changed since you opened this - reopen the dialog to edit the latest.` | `Las instrucciones personalizadas han cambiado desde que abriste esto - vuelve a abrir el diálogo para editar la versión más reciente.` | `Les instruccions personalitzades han canviat des que vas obrir això - torna a obrir el diàleg per editar la versió més recent.` |
| `dialogs.agent.systemPromptHint` | `Run <code>/isomux-system-prompt</code> in a chat to see the agent's full system prompt.` | `Ejecuta <code>/isomux-system-prompt</code> en un chat para ver el prompt de sistema completo del agente.` | `Executa <code>/isomux-system-prompt</code> en un xat per veure el prompt de sistema complet de l'agent.` |
| `dialogs.agent.template` | `Start with a template` | `Empezar con una plantilla` | `Començar amb una plantilla` |
| `dialogs.agent.templateHint` | `Templates fill the fields below. You can edit every suggestion.` | `Las plantillas rellenan los campos de abajo. Puedes editar todas las sugerencias.` | `Les plantilles omplen els camps de sota. Pots editar totes les propostes.` |
| `dialogs.agent.titleEdit` | `Edit Agent` | `Editar el agente` | `Editar l'agent` |
| `dialogs.agent.titleSpawn` | `Spawn New Agent` | `Crear un agente nuevo` | `Crear un agent nou` |
| `dialogs.schedule.create` | `Create` | `Crear` | `Crea` |
| `dialogs.schedule.daily` | `Daily` | `Cada día` | `Cada dia` |
| `dialogs.schedule.enabled` | `Enabled (uncheck to pause without deleting)` | `Activada (desmárcala para pausarla sin eliminarla)` | `Activada (desmarca-la per posar-la en pausa sense eliminar-la)` |
| `dialogs.schedule.hour` | `Hour (0-23)` | `Hora (0-23)` | `Hora (0-23)` |
| `dialogs.schedule.interval` | `Every N minutes` | `Cada N minutos` | `Cada N minuts` |
| `dialogs.schedule.intervalMinutes` | `Interval (minutes, min 5)` | `Intervalo (minutos, mínimo 5)` | `Interval (minuts, mínim 5)` |
| `dialogs.schedule.minute` | `Minute (0-59)` | `Minuto (0-59)` | `Minut (0-59)` |
| `dialogs.schedule.namePlaceholder` | `Daily summary` | `Resumen diario` | `Resum diari` |
| `dialogs.schedule.permissionHint` | `Schedules run unattended - modes that require human approval are not available.` | `Las programaciones se ejecutan sin supervisión - los modos que piden aprobación humana no están disponibles.` | `Les programacions s'executen sense supervisió - els modes que demanen aprovació humana no estan disponibles.` |
| `dialogs.schedule.permissionHintOpenCode` | `Shell and edit tools are allowed. Delegation and questions are denied.` | `Se permiten las herramientas de shell y de edición. Se deniegan la delegación y las preguntas.` | `Es permeten les eines de shell i d'edició. Es deneguen la delegació i les preguntes.` |
| `dialogs.schedule.permissionUnattended` | `Allow project tools (unattended)` | `Permitir las herramientas del proyecto (sin supervisión)` | `Permetre les eines del projecte (sense supervisió)` |
| `dialogs.schedule.prompt` | `Prompt` | `Prompt` | `Prompt` |
| `dialogs.schedule.promptEmpty` | `Prompt cannot be empty.` | `El prompt no puede estar vacío.` | `El prompt no pot estar buit.` |
| `dialogs.schedule.promptPlaceholder` | `e.g. "Summarize what every agent accomplished yesterday."` | `p. ej. "Resume lo que consiguió ayer cada agente."` | `p. ex. "Resumeix què va aconseguir ahir cada agent."` |
| `dialogs.schedule.promptTitle` | `Schedule Prompt` | `Prompt de la programación` | `Prompt de la programació` |
| `dialogs.schedule.serverLocal` | `Times are server-local.` | `Las horas son las del servidor.` | `Les hores són les del servidor.` |
| `dialogs.schedule.titleEdit` | `Edit Schedule` | `Editar la programación` | `Editar la programació` |
| `dialogs.schedule.titleNew` | `New Schedule` | `Programación nueva` | `Programació nova` |
| `dialogs.schedule.weekday.friday` | `Friday` | `Viernes` | `Divendres` |
| `dialogs.schedule.weekday.monday` | `Monday` | `Lunes` | `Dilluns` |
| `dialogs.schedule.weekday.saturday` | `Saturday` | `Sábado` | `Dissabte` |
| `dialogs.schedule.weekday.sunday` | `Sunday` | `Domingo` | `Diumenge` |
| `dialogs.schedule.weekday.thursday` | `Thursday` | `Jueves` | `Dijous` |
| `dialogs.schedule.weekday.tuesday` | `Tuesday` | `Martes` | `Dimarts` |
| `dialogs.schedule.weekday.wednesday` | `Wednesday` | `Miércoles` | `Dimecres` |
| `dialogs.schedule.weekly` | `Weekly` | `Cada semana` | `Cada setmana` |
| `dialogs.schedulePrompt.appliedNextRun` | `Applied to the next run; in-flight runs use their captured snapshot.` | `Se aplica a la próxima ejecución; las que están en curso usan la copia que capturaron.` | `S'aplica a l'execució següent; les que ja s'estan executant fan servir la còpia que van capturar.` |
| `dialogs.schedulePrompt.rulesHint` | `(system prompt for all schedules)` | `(prompt de sistema para todas las programaciones)` | `(prompt de sistema per a totes les programacions)` |
| `dialogs.schedulePrompt.rulesPlaceholder` | `e.g. Always write findings to a markdown file. Be terse.` | `p. ej. Escribe siempre los hallazgos en un archivo markdown. Sé conciso.` | `p. ex. Escriu sempre les troballes en un fitxer markdown. Sigues concís.` |
| `dialogs.schedulePrompt.title` | `Schedules Settings` | `Ajustes de las programaciones` | `Configuració de les programacions` |
| `logView.attachFiles` | `Attach files` | `Adjuntar archivos` | `Adjunta fitxers` |
| `nav.showFloorView` | `Show floor view` | `Mostrar la vista de planta` | `Mostra la vista de planta` |
| `office.tabs.closeEmptyRoom` | `Close empty room` | `Cerrar la sala vacía` | `Tanca la sala buida` |
| `office.tabs.newRoom` | `Create new room` | `Crear una sala nueva` | `Crea una sala nova` |
| `office.tabs.roomSettings` | `Double-click for room settings` | `Haz doble clic para la configuración de la sala` | `Fes doble clic per a la configuració de la sala` |
| `office.tabs.scrollLeft` | `Scroll rooms left` | `Desplazar las salas a la izquierda` | `Desplaça les sales a l'esquerra` |
| `office.tabs.scrollRight` | `Scroll rooms right` | `Desplazar las salas a la derecha` | `Desplaça les sales a la dreta` |
| `schedules.anyMoment` | `in any moment` | `en cualquier momento` | `en qualsevol moment` |
| `schedules.col.by` | `BY` | `POR` | `PER` |
| `schedules.col.duration` | `DURATION` | `DURACIÓN` | `DURADA` |
| `schedules.col.lastRun` | `LAST RUN` | `ÚLTIMA` | `DARRERA` |
| `schedules.col.name` | `NAME` | `NOMBRE` | `NOM` |
| `schedules.col.nextRun` | `NEXT RUN` | `SIGUIENTE` | `SEGÜENT` |
| `schedules.col.preview` | `PREVIEW` | `VISTA PREVIA` | `VISTA PRÈVIA` |
| `schedules.col.runs` | `RUNS` | `EJECUCIONES` | `EXECUCIONS` |
| `schedules.col.schedule` | `SCHEDULE` | `PROGRAMACIÓN` | `PROGRAMACIÓ` |
| `schedules.col.started` | `STARTED` | `INICIO` | `INICI` |
| `schedules.col.status` | `S` | `E` | `E` |
| `schedules.col.trigger` | `T` | `D` | `D` |
| `schedules.createdByFor` | `{creator} · for {user}` | `{creator} · para {user}` | `{creator} · per a {user}` |
| `schedules.deleted` | `(deleted)` | `(eliminada)` | `(eliminada)` |
| `schedules.editingAbove` | `Editing message above...` | `Editando el mensaje de arriba...` | `S'està editant el missatge de dalt...` |
| `schedules.empty` | `No schedules yet. Click "+ New" to create one.` | `Aún no hay programaciones. Haz clic en "+ Nueva" para crear una.` | `Encara no hi ha programacions. Fes clic a "+ Nova" per crear-ne una.` |
| `schedules.enabledToggle` | `Enabled (click to pause)` | `Activada (haz clic para pausarla)` | `Activada (fes clic per posar-la en pausa)` |
| `schedules.errorLine` | `Error: {reason}` | `Error: {reason}` | `Error: {reason}` |
| `schedules.filterLabel` | `Schedule:` | `Programación:` | `Programació:` |
| `schedules.followUp` | `Send a follow-up` | `Enviar un seguimiento` | `Envia un seguiment` |
| `schedules.inFlight` | `running` | `en curso` | `en curs` |
| `schedules.newButton` | `+ New` | `+ Nueva` | `+ Nova` |
| `schedules.nextPage` | `Next →` | `Siguiente →` | `Següent →` |
| `schedules.nextRunIn` | `in {duration}` | `en {duration}` | `d'aquí a {duration}` |
| `schedules.noEntries` | `No log entries.` | `No hay entradas de registro.` | `No hi ha entrades de registre.` |
| `schedules.noSession` | `This run can't be resumed (no session was established).` | `Esta ejecución no se puede reanudar (no se estableció ninguna sesión).` | `Aquesta execució no es pot reprendre (no es va establir cap sessió).` |
| `schedules.paused` | `paused` | `en pausa` | `en pausa` |
| `schedules.pausedToggle` | `Paused (click to enable)` | `En pausa (haz clic para activarla)` | `En pausa (fes clic per activar-la)` |
| `schedules.prevPage` | `← Prev` | `← Anterior` | `← Anterior` |
| `schedules.promptLabel` | `PROMPT` | `PROMPT` | `PROMPT` |
| `schedules.run` | `Run` | `Ejecutar` | `Executa` |
| `schedules.runNow` | `Run now` | `Ejecutar ahora` | `Executa-la ara` |
| `schedules.runNumber` | `Run #{id}` | `Ejecución n.º {id}` | `Execució núm. {id}` |
| `schedules.runSkipped` | `This run was skipped.` | `Esta ejecución se omitió.` | `Aquesta execució es va ometre.` |
| `schedules.running` | `running…` | `en curso…` | `en curs…` |
| `schedules.runningDots` | `Running...` | `En curso...` | `En curs...` |
| `schedules.runsEmpty` | `No runs yet.` | `Aún no hay ejecuciones.` | `Encara no hi ha execucions.` |
| `schedules.skippedNoSession` | `Skipped runs have no session to resume.` | `Las ejecuciones omitidas no tienen ninguna sesión que reanudar.` | `Les execucions omeses no tenen cap sessió per reprendre.` |
| `schedules.snapshot` | `cwd: {cwd} · model: {model} · effort: {effort} · permission: {permission}` | `cwd: {cwd} · modelo: {model} · esfuerzo: {effort} · permiso: {permission}` | `cwd: {cwd} · model: {model} · esforç: {effort} · permís: {permission}` |
| `schedules.status.completed` | `Completed` | `Completada` | `Completada` |
| `schedules.status.failed` | `Failed` | `Fallida` | `Fallida` |
| `schedules.status.running` | `Running` | `En curso` | `En curs` |
| `schedules.status.skipped` | `Skipped` | `Omitida` | `Omesa` |
| `schedules.status.timedOut` | `Timed out` | `Tiempo agotado` | `Temps esgotat` |
| `schedules.tab.cronjobs` | `schedules` | `programaciones` | `programacions` |
| `schedules.tab.runs` | `runs` | `ejecuciones` | `execucions` |
| `schedules.trigger.manual` | `manual` | `manual` | `manual` |
| `schedules.trigger.manualBy` | `manual · {who}` | `manual · {who}` | `manual · {who}` |
| `schedules.trigger.scheduled` | `scheduled` | `programada` | `programada` |
| `schedules.waitToFollowUp` | `Run in progress - wait for it to finish before sending a follow-up.` | `Ejecución en curso: espera a que termine antes de enviar un seguimiento.` | `Execució en curs: espera que acabi abans d'enviar un seguiment.` |
