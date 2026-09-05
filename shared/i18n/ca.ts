// Catalan. Informal register (tu), never vostè (ruling 1). Button labels use
// the imperative, the Catalan UI convention. Proper nouns, commands and the
// word DELETE that the storage confirm asks for stay as they are (ruling 11).

import type { Catalog } from "./en.ts";

export const ca: Catalog = {
  "common.save": "Desa",
  "common.saving": "Desant…",
  "common.saved": "Desat",
  "common.cancel": "Cancel·la",
  "common.loading": "Carregant…",
  "common.loadingMemory": "Carregant la memòria…",
  "common.memory": "Memòria",
  "common.memoryEditorHint":
    "Aquest editor reescriu el fitxer tal com es mostra. Fes servir una memòria per línia.",
  "common.saveFailed": "No s'ha pogut desar",
  "common.nextConversation": "Els canvis s'apliquen a la conversa següent.",
  "common.settings": "Configuració",
  "common.theme": "Tema",
  "common.preferences": "Preferències",
  "common.checking": "Comprovant…",

  "nav.tasks": "Tasques",
  "nav.schedules": "Programacions",
  "nav.apps": "Apps",
  "nav.changeTheme": "Canvia el tema",
  "nav.showAgentList": "Mostra la llista d'agents",
  "nav.showFloorView": "Mostra la vista de planta",

  "preferences.intro":
    "Et segueixen a tots els dispositius des dels quals inicies la sessió. La configuració específica d'aquest navegador és a Els meus dispositius.",
  "preferences.language": "Idioma",
  "preferences.languageHint":
    "L'idioma en què escriuen els teus agents, i el que fan servir l'entrada de veu i la lectura en veu alta. Els agents l'apliquen a la conversa següent. La resta de la interfície continua en anglès de moment.",
  "preferences.saved": "Desat.",
  "preferences.saveFailed": "No s'ha pogut desar",

  "settings.backToOffice": "Torna a l'oficina",
  "settings.selectHint": "Tria una opció de la llista",
  "settings.profilesNote":
    "Els perfils d'usuari es desen al servidor. Les teves notificacions i credencials et segueixen entre dispositius.",
  "settings.signOut": "Tanca la sessió",
  "settings.signOutHint": "Tanca la sessió d'aquest dispositiu",
  "settings.you": "(tu)",
  "settings.sidebar.office": "Oficina",
  "settings.sidebar.access": "Accés",
  "settings.sidebar.invites": "Invitacions",
  "settings.sidebar.sessions": "Sessions",
  "settings.sidebar.connectionsOffice": "Connexions de tota l'oficina",
  "settings.sidebar.usage": "Ús",
  "settings.sidebar.storage": "Emmagatzematge",
  "settings.sidebar.updates": "Actualitzacions",
  "settings.sidebar.you": "Tu",
  "settings.sidebar.profile": "Perfil",
  "settings.sidebar.connectionsPersonal": "Connexions individuals",
  "settings.sidebar.apiTokens": "Tokens d'API",
  "settings.sidebar.signInLinks": "Enllaços d'inici de sessió",
  "settings.sidebar.device": "Dispositiu",
  "settings.sidebar.deviceLabel": "Etiqueta del dispositiu",
  "settings.sidebar.rooms": "Sales",
  "settings.sidebar.members": "Membres",
  "settings.members.editHint":
    "Només el mateix usuari i els propietaris poden editar un usuari",
  "settings.members.onlineNow": "En línia ara",
  "settings.members.online": "en línia",
  "settings.members.onlineSessions.one": "en línia · {count} sessió",
  "settings.members.onlineSessions.other": "en línia · {count} sessions",
  "settings.members.lastSeen": "vist per última vegada {when}",
  "settings.role.owner": "propietari",
  "settings.role.member": "membre",
  "settings.role.ownerHint":
    "Propietari - pot convidar usuaris, revocar sessions i fixar l'accés a sales de cada usuari",
  "settings.role.memberHint":
    "Membre - pot actuar a les sales que el propietari li ha permès; no pot convidar ni revocar",

  "settings.profile.identity": "Identitat",
  "settings.profile.displayName": "Nom visible",
  "settings.profile.rooms": "Sales",
  "settings.profile.accessHint":
    "Accés: sales que aquest usuari pot veure i on pot actuar (ho gestiona el propietari).",
  "settings.profile.viewHint":
    "Mostrades: quines de les teves sales accessibles apareixen a la teva vista. Notificacions: so quan un agent d'aquella sala acaba. Una sala ha d'estar mostrada per notificar.",
  "settings.profile.roomColumn": "Sala",
  "settings.profile.accessColumn": "Accés",
  "settings.profile.displayedColumn": "Mostrada",
  "settings.profile.notificationsColumn": "Notificacions",
  "settings.profile.noRooms": "Encara no hi ha sales.",
  "settings.profile.accessTo": "Accés a {room}",
  "settings.profile.display": "Mostra {room}",
  "settings.profile.notificationsFor": "Notificacions de {room}",
  "settings.profile.agentContext": "Context per als agents",
  "settings.profile.profilePrompt": "Prompt de perfil",
  "settings.profile.profilePromptHint":
    "(s'injecta al prompt de sistema dels agents que tens; els agents d'altres usuaris el poden consultar si necessiten context sobre tu)",
  "settings.profile.profilePromptTitle": "{user} · Prompt de perfil",
  "settings.profile.profilePromptExpandedHint":
    "S'injecta al prompt de sistema dels agents d'aquest usuari; els agents d'altres usuaris el poden consultar si necessiten context sobre ell.",
  "settings.profile.profilePromptPlaceholder":
    "Unes notes per als agents sobre qui ets, el teu rol, com t'agrada col·laborar…",
  "settings.profile.memoryHint":
    "(fets duradors sobre aquest usuari; reescriu el fitxer tal com es mostra - una memòria per línia; {size} / {cap})",
  "settings.profile.memoryTitle": "{user} · Memòria",
  "settings.profile.memoryPlaceholder":
    "Alguna memòria rellevant per a aquest usuari",
  "settings.profile.appearance": "Aparença",
  "settings.profile.avatar": "Avatar",
  "settings.profile.avatarHint":
    "(el teu fantasma a l'escena de l'oficina; els altres usuaris el veuen al costat de l'agent que estàs mirant)",
  "settings.profile.discardPrompt": "Vols descartar els canvis sense desar?",
  "settings.profile.discard": "Descarta",
  "settings.profile.delete": "Elimina",
  "settings.profile.deleteHint": "Elimina aquest usuari",
  "settings.profile.confirmDelete": "Ho confirmes?",
  "settings.profile.deleteFailed": "No s'ha pogut eliminar",
  "settings.profile.roomListFailed":
    "No s'ha pogut confirmar la teva llista de sales; Mostrades no s'ha desat.",

  "settings.office.title": "Configuració de l'oficina",
  "settings.office.intro":
    "El rètol emmarcat de la paret de l'oficina obre aquesta pàgina.",
  "settings.office.viewOnly":
    "Només lectura. Només els propietaris de l'oficina poden editar la configuració de tota l'oficina.",
  "settings.office.name": "Nom de l'oficina",
  "settings.office.nameHint":
    "(opcional, es mostra a la pestanya del navegador)",
  "settings.office.namePlaceholder": "Oficina del Nil",
  "settings.office.rules": "Regles",
  "settings.office.rulesHint": "(prompt de sistema per a tots els agents)",
  "settings.office.rulesTitle": "Regles de l'oficina",
  "settings.office.rulesExpandedHint":
    "Prompt de sistema per a tots els agents. Els canvis s'apliquen a la conversa següent.",
  "settings.office.rulesPlaceholder":
    "p. ex. Escriu sempre tests. Fes servir TypeScript. Sigues concís.",
  "settings.office.memoryHint":
    "(fets duradors de tota l'oficina; línies en brut; {size} / {cap})",
  "settings.office.memoryTitle": "Memòria de l'oficina",
  "settings.office.memoryPlaceholder":
    "Alguna memòria rellevant per a tota l'oficina",
  "settings.office.reloadFailed":
    "Desat, però aquesta pàgina no ha pogut recarregar l'oficina. Tria una altra fila i torna per continuar editant.",
  "settings.office.conflict":
    "La configuració de l'oficina ha canviat en un altre lloc des que es va carregar aquesta pàgina. Tria una altra fila i torna per carregar l'última versió.",
  "settings.office.loadedVariables.one": "S'ha carregat {count} variable.",
  "settings.office.loadedVariables.other": "S'han carregat {count} variables.",
  "settings.office.discardConfirm":
    "Vols descartar els canvis de l'oficina sense desar?",

  "settings.room.title": "{room} · Configuració",
  "settings.room.intro":
    "Fes doble clic en una pestanya de sala per venir directament aquí.",
  "settings.room.name": "Nom",
  "settings.room.namePlaceholder": "Nom de la sala",
  "settings.room.prompt": "Prompt de la sala",
  "settings.room.promptHint":
    "(opcional, s'afegeix després del prompt de l'oficina)",
  "settings.room.promptTitle": "{room} · Prompt de la sala",
  "settings.room.promptPlaceholder":
    "p. ex. Ets a la sala de Màrqueting. Segueix la veu de la nostra marca.",
  "settings.room.promptNote":
    "Els canvis s'apliquen a la conversa següent. Defineix les variables d'entorn a Connexions de tota l'oficina o Connexions individuals.",
  "settings.room.memoryHint":
    "(fets duradors d'aquesta sala; línies en brut; {size} / {cap})",
  "settings.room.memoryTitle": "{room} · Memòria",
  "settings.room.memoryPlaceholder":
    "Alguna memòria rellevant per a aquesta sala",
  "settings.room.reloadFailed":
    "Desat, però aquesta pàgina no ha pogut recarregar la sala. Tria una altra fila i torna per continuar editant.",
  "settings.room.conflict":
    "La configuració de la sala ha canviat en un altre lloc des que es va carregar aquesta pàgina. Tria una altra fila i torna per carregar l'última versió.",
  "settings.room.deleteEmpty": "Elimina la sala buida",
  "settings.room.discardConfirm":
    "Vols descartar els canvis d'aquesta sala sense desar?",

  "settings.theme.intro":
    "Es desa en aquest navegador. També pots fer clic a la finestra de l'oficina per recórrer els temes sense obrir aquesta pàgina.",

  "settings.device.intro":
    'Es desa en aquest navegador. Diu als agents en quin dispositiu ets (per exemple "Mòbil" davant de "Portàtil") perquè adaptin les respostes.',
  "settings.device.label": "Etiqueta del dispositiu",
  "settings.device.optional": "(opcional)",
  "settings.device.placeholder": "Mòbil, Portàtil, …",
  "settings.device.discardConfirm":
    "Vols descartar els canvis de l'etiqueta del dispositiu sense desar?",

  "settings.devices.title": "Els meus dispositius",
  "settings.devices.outstandingLinks": "Enllaços de dispositiu pendents",
  "settings.devices.activeSessions": "Les meves sessions actives",
  "settings.devices.generateHint":
    "Genera un enllaç d'un sol ús per iniciar la sessió amb un altre dels teus dispositius al teu compte. L'enllaç caduca en 1 hora; generar-ne un de nou substitueix l'anterior.",
  "settings.devices.generateWarning":
    "Qualsevol que tingui l'enllaç pot iniciar la sessió com tu fins que caduqui o es faci servir - tracta'l com una contrasenya d'un sol ús i obre'l només al teu propi dispositiu.",
  "settings.devices.generating": "Generant…",
  "settings.devices.generate": "Genera un enllaç de dispositiu",
  "settings.devices.generateFailed":
    "No s'ha pogut generar l'enllaç de dispositiu",

  "settings.update.newRelease": "Nova versió disponible",
  "settings.update.upToDateTitle": "Actualitzat",
  "settings.update.upToDate": "Aquesta oficina està actualitzada.",
  "settings.update.releaseNotesParen": "(notes de la versió)",
  "settings.update.githubParen": "(GitHub)",
  "settings.update.toUpdate": "Per actualitzar:",
  "settings.update.stepPull": "Descarrega els últims canvis",
  "settings.update.stepInstall": "Executa <code>bun install</code>",
  "settings.update.stepRestart":
    "Reinicia isomux perquè l'actualització s'apliqui. Desenvolupament: <code>bun run dev</code>. Servei d'usuari: <code>systemctl --user restart isomux</code>. Servei de sistema: <code>sudo systemctl restart isomux</code>.",
  "settings.update.tip":
    "Consell: prem el botó de copiar per copiar aquest avís al porta-retalls i després demana a qualsevol agent que se n'encarregui.",
  "settings.update.requested":
    "Actualització sol·licitada. El servidor es reiniciarà aviat i aquesta pàgina es tornarà a connectar. Si no passa res al cap d'uns minuts, revisa el fitxer d'estat de l'actualitzador al servidor.",
  "settings.update.close": "Tanca",
  "settings.update.runningOn": "Ets a <code>{version}</code>",
  "settings.update.unknownVersion": "una versió desconeguda",
  "settings.update.latestRelease":
    "Última versió: <code>{tag}</code>{published}",
  "settings.update.releaseNotes": "notes de la versió",
  "settings.update.restartWarning":
    "Actualitzar reinicia el servidor i interromp tots els agents.",
  "settings.update.busyNone": "Cap agent és a mitja tasca ara mateix.",
  "settings.update.busy.one": "{count} agent és a mitja tasca ara mateix.",
  "settings.update.busy.other": "{count} agents són a mitja tasca ara mateix.",
  "settings.update.busyUnavailable":
    "El recompte d'agents ocupats no està disponible ara mateix.",
  "settings.update.ownerOnly":
    "Un propietari de l'oficina la pot aplicar des d'aquest diàleg.",
  "settings.update.updateNow": "Actualitza ara",
  "settings.update.updateNowBusy": "Actualitza ara ({count} ocupats)",
  "settings.update.updating": "Actualitzant…",
  "settings.update.gotIt": "Entesos",

  "settings.usage.title": "Ús de l'oficina",
  "settings.usage.intro":
    "Els límits del pla de subscripció no es mostren aquí. Aquesta pàgina informa de l'ús de tokens i del cost estimat que registra Isomux.",
  "settings.usage.scoped":
    "Limitat a les sales a què tens accés. L'ús de les programacions no s'hi inclou.",
  "settings.usage.loadFailed": "No s'ha pogut carregar l'ús.",
  "settings.usage.agents": "Ús per agent",
  "settings.usage.agentColumn": "Agent",
  "settings.usage.rooms": "Ús per sala",
  "settings.usage.roomsNote":
    "Els agents eliminats compten a l'última sala on van ser.",
  "settings.usage.roomColumn": "Sala",
  "settings.usage.deleted": "eliminada",
  "settings.usage.schedules": "Ús per programació",
  "settings.usage.scheduleColumn": "Programació",
  "settings.usage.total": "Total",
  "settings.usage.officeTotal": "Total de l'oficina",
  "settings.usage.inSession": "Entrada (ses.)",
  "settings.usage.outSession": "Sortida (ses.)",
  "settings.usage.costSession": "$ (ses.)",
  "settings.usage.inLifetime": "Entrada (total)",
  "settings.usage.outLifetime": "Sortida (total)",
  "settings.usage.costLifetime": "$ (total)",
  "settings.usage.cacheHit": "{count} ({hit} % d'encerts)",

  "settings.storage.title": "Emmagatzematge de l'oficina",
  "settings.storage.category.transcripts": "Transcripcions de converses",
  "settings.storage.category.attachments": "Adjunts del xat",
  "settings.storage.category.sessionMetadata": "Metadades de sessió",
  "settings.storage.category.codexHome": "Directori de Codex",
  "settings.storage.category.providerHomes":
    "Directoris personals de proveïdors",
  "settings.storage.category.cronjobs": "Historial de programacions",
  "settings.storage.category.otherState": "Tota la resta",
  "settings.storage.category.backups": "Còpies de seguretat",
  "settings.storage.category.updateSnapshots": "Instantànies d'actualització",
  "settings.storage.skip.tooRecent": "més recents que el límit d'antiguitat",
  "settings.storage.skip.keepNewest":
    "entre les més recents que es conserven per al seu agent",
  "settings.storage.skip.activeSession":
    "pertanyen a una conversa que encara és activa",
  "settings.storage.skip.forkAncestor":
    "una altra conversa s'ha bifurcat a partir d'elles",
  "settings.storage.skip.referenced":
    "encara es mostren en una conversa que pots llegir",
  "settings.storage.skip.queueStateUnknown":
    "esperen en una cua de missatges que no s'ha pogut llegir",
  "settings.storage.measureFailed": "No s'ha pogut mesurar l'emmagatzematge.",
  "settings.storage.previewFailed": "La sol·licitud de neteja ha fallat.",
  "settings.storage.deleteFailed": "La sol·licitud d'esborrat ha fallat.",
  "settings.storage.deleteDidNotRun":
    "L'esborrat no s'ha executat. No s'ha eliminat res.",
  "settings.storage.leaveConfirm":
    "Encara hi ha una neteja en marxa. Si surts ara perds l'únic informe del que ha esborrat. Vols sortir igualment?",
  "settings.storage.deleteSection": "Esborra fitxers antics",
  "settings.storage.deleteWarningLead":
    "Això esborra fitxers d'aquesta màquina de manera permanent.",
  "settings.storage.deleteWarningBody":
    "No hi ha desfer ni paperera. Les converses i els adjunts antics només s'esborren quan executes aquesta neteja.",
  "settings.storage.whatToDelete": "Què esborrar",
  "settings.storage.olderThan": "Més antics que",
  "settings.storage.daysHint":
    "dies. Tot el que s'ha tocat més recentment es conserva.",
  "settings.storage.keepPerAgent": "Conserva sempre, per agent",
  "settings.storage.keepHint":
    "converses més recents, per antigues que siguin. 0 no en conserva cap per aquest criteri.",
  "settings.storage.preview": "Previsualitza què s'esborraria",
  "settings.storage.measuring": "Mesurant…",
  "settings.storage.onDisk": "Què hi ha al disc",
  "settings.storage.totalSplit":
    "<strong>{total} en total</strong> - {state} d'estat de l'oficina, més {outside} fora d'ell.",
  "settings.storage.totalAllState":
    "<strong>{total} en total</strong>, tot estat de l'oficina.",
  "settings.storage.measured": "Mesurat {when}.",
  "settings.storage.totalOfficeState": "Total de l'estat de l'oficina",
  "settings.storage.outsideOfficeState": "Fora de l'estat de l'oficina",
  "settings.storage.none": "cap",
  "settings.storage.outsideNote":
    "Les còpies de seguretat i les instantànies d'actualització són fora del directori d'estat de l'oficina, així que es llisten després del seu subtotal. “cap” vol dir que aquesta ubicació no està configurada en aquesta màquina.",
  "settings.storage.backupUnavailable":
    "Estat de les còpies de seguretat no disponible.",
  "settings.storage.noBackupYet": "Encara no s'ha fet cap còpia de seguretat.",
  "settings.storage.lastBackupOk":
    "Última còpia de seguretat {when}, correcta.",
  "settings.storage.lastBackupFailed":
    "Última còpia de seguretat {when} FALLIDA.",
  "settings.storage.lastBackupFailedWith":
    "Última còpia de seguretat {when} FALLIDA: {error}",
  "settings.storage.backupKeeping":
    "Es conserven {retention} a <code>{destDir}</code>.",
  "settings.storage.planCount":
    "S'esborrarien {count} {target}, alliberant {size}.",
  "settings.storage.planEmpty":
    "Res no coincideix. Cap de les {target} és prou antiga per esborrar-la.",
  "settings.storage.planPreviewNote":
    "Encara no s'ha esborrat res - això és una previsualització.",
  "settings.storage.skippedRow": "{count} conservades ({size}): {reason}",
  "settings.storage.sampleRow": "{path} - {size}, {age} d d'antiguitat",
  "settings.storage.sampleMore": "…i {count} més.",
  "settings.storage.queueUnreadable":
    "Isomux no ha pogut llegir la cua de missatges pendents, així que no pot saber quins adjunts encara s'han d'entregar amb missatges pendents. No s'esborrarà res fins que es pugui tornar a llegir.",
  "settings.storage.deleteCount":
    "Esborra {count} {target} de manera permanent",
  "settings.storage.cannotUndo": "Això no es pot desfer.",
  "settings.storage.confirmBody":
    "La previsualització ha trobat {size} de {target} per esborrar d'aquesta màquina. Una còpia de seguretat pot contenir una altra còpia, si s'ha fet després d'escriure aquests fitxers. Isomux torna a escanejar abans d'esborrar. Els fitxers que ja no coincideixen o no passen una comprovació de seguretat es conserven, així que el recompte final pot diferir d'aquesta previsualització.",
  "settings.storage.confirmPlaceholder": "Escriu DELETE per confirmar",
  "settings.storage.deleting": "Esborrant…",
  "settings.storage.deletePermanently": "Esborra de manera permanent",
  "settings.storage.aborted": "S'ha aturat abans d'esborrar res: {reason}",
  "settings.storage.deletedResult":
    "S'han esborrat {count} fitxers, alliberant {size}.",
  "settings.storage.refused":
    "{count} no s'han pogut eliminar i s'han deixat com estaven.",
};
