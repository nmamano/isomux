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
  "common.schedule": "Programació",
  "common.discardPrompt": "Vols descartar els canvis sense desar?",
  "common.delete": "Elimina",
  "common.confirmQuestion": "Ho confirmes?",
  "common.settings": "Configuració",
  "common.theme": "Tema",
  "common.preferences": "Preferències",
  "common.checking": "Comprovant…",
  "common.copied": "Copiat",
  "common.copy": "Copia",
  "common.device": "Dispositiu",
  "common.discard": "Descarta",
  "common.justNow": "ara mateix",
  "common.name": "Nom",
  "common.noRooms": "Encara no hi ha sales.",
  "common.prefix": "Prefix",
  "common.revoke": "Revoca",
  "common.rules": "Regles",
  "common.role": "Rol",
  "common.rooms": "Sales",
  "common.signOut": "Tanca la sessió",
  "common.user": "Usuari",

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
  "settings.sidebar.deviceLabel": "Etiqueta del dispositiu",
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
  "settings.profile.accessHint":
    "Accés: sales que aquest usuari pot veure i on pot actuar (ho gestiona el propietari).",
  "settings.profile.viewHint":
    "Mostrades: quines de les teves sales accessibles apareixen a la teva vista. Notificacions: so quan un agent d'aquella sala acaba. Una sala ha d'estar mostrada per notificar.",
  "settings.profile.roomColumn": "Sala",
  "settings.profile.accessColumn": "Accés",
  "settings.profile.displayedColumn": "Mostrada",
  "settings.profile.notificationsColumn": "Notificacions",
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
  "settings.profile.deleteHint": "Elimina aquest usuari",
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

  "settings.access.none": "Cap.",
  "settings.access.expired": "caducada",
  "settings.access.expiresUnderHour": "0 h",
  "settings.access.localTime": "{time} local",
  "settings.access.inviteUrl": "URL d'invitació",
  "settings.access.copyUrl": "Copia la URL",
  "settings.access.urlCopied": "Copiada!",
  "settings.access.clipboardBlocked":
    "Porta-retalls bloquejat. La URL de dalt està seleccionada - copia-la a mà.",
  "settings.access.sendUrl":
    "Envia aquesta URL a la persona convidada. És d'un sol ús: en obrir-la al seu dispositiu, hi entra. La URL es mostra un cop - copia-la ara.",
  "settings.access.dismiss": "Tanca",

  "settings.invites.intro":
    "Afegeix un membre o un propietari: emet una URL d'invitació i envia-l'hi per un altre canal. En obrir-la es crea el seu compte i aquell dispositiu hi entra. Per a més dispositius en un compte que ja existeix, cadascú genera el seu propi enllaç des de <i>Els meus dispositius</i>.",
  "settings.invites.issueFor": "Emet una invitació per a…",
  "settings.invites.namePlaceholder": "Nom nou (p. ex. Marc)",
  "settings.invites.existing":
    "<b>{name}</b> ja existeix, així que no cal cap invitació: per entrar amb un altre dispositiu, {name} pot generar un enllaç des d'<i>Els meus dispositius</i> a la seva configuració - o li pots emetre un enllaç de recuperació aquí sota.",
  "settings.invites.grantRoom": "Dona accés a {room}",
  "settings.invites.roomsHint":
    "La persona convidada hi entra amb accés a les sales marcades. Deixa-les totes sense marcar per donar-li accés més tard des de la seva configuració.",
  "settings.invites.expiryHint":
    "L'enllaç d'invitació caduca 24 h després d'emetre'l si no s'usa. Les sessions acceptades duren fins a 1 any (revocables des de la secció Sessions en qualsevol moment).",
  "settings.invites.minting": "Emetent…",
  "settings.invites.issue": "Emet la invitació",
  "settings.invites.mintFailed": "No s'ha pogut emetre la invitació",
  "settings.invites.recovery": "Recuperació",
  "settings.invites.recoveryHint":
    "Ajuda algú que ja té compte a tornar a entrar. Els enllaços de dispositiu són autoservei, però qui ha sortit de tots els seus dispositius no se'n pot generar cap - tria'l aquí i envia-li l'enllaç per un altre canal. Caduca en 24 h; en emetre'n un de nou se substitueix l'anterior.",
  "settings.invites.selectUser": "Tria algú…",
  "settings.invites.mintRecovery": "Emet un enllaç de recuperació",
  "settings.invites.recoveryFailed":
    "No s'ha pogut emetre l'enllaç de recuperació",
  "settings.invites.outstanding": "Invitacions pendents",
  "settings.invites.columnFor": "Per a",
  "settings.invites.columnExpires": "Caduca",
  "settings.invites.bootstrap": "(inicial)",

  "settings.sessions.intro":
    "Dispositius que han entrat en aquesta oficina, de tothom. Revocar una sessió en treu aquell dispositiu. Qui és nou rep una invitació des de la secció Invitacions; qui ja té compte afegeix dispositius des d'<i>Els meus dispositius</i>.",
  "settings.sessions.columnLastSeen": "Vist per última vegada",
  "settings.sessions.columnCreated": "Creada",
  "settings.sessions.currentSession": "Sessió actual",
  "settings.sessions.currentSessionHint":
    "Fes servir Tanca la sessió al final de la barra lateral per acabar la teva sessió actual.",
  "settings.sessions.expiryInactivity": "Caduca per inactivitat",
  "settings.sessions.expiryLatest": "Caduca com a molt tard",

  "settings.externalAccess.intro":
    "Controla si es pot arribar a aquesta oficina des de fora d'aquesta màquina. Els enllaços d'invitació i els dispositius que hi han entrat són a les seccions Invitacions i Sessions.",
  "settings.externalAccess.title": "Accés extern",
  "settings.externalAccess.loopback":
    "Ara mateix només per loopback. S'arriba a l'oficina des d'aquesta màquina, o des d'altres a través d'un túnel SSH.",
  "settings.externalAccess.external":
    "Ara mateix accepta connexions externes. S'arriba a l'oficina des de qualsevol lloc on resolgui la URL pública.",
  "settings.externalAccess.enable": "Activa l'accés extern",
  "settings.externalAccess.publicUrl": "URL pública",
  "settings.externalAccess.urlHint":
    "Patró: {pattern} (l'adreça que obriràs des del portàtil o el mòbil). Desar no canvia per si sol la interfície on escolta el servidor - reinicia isomux per aplicar-ho.",
  "settings.externalAccess.envInvalid":
    "Nota: <code>ISOMUX_PUBLIC_ORIGIN</code> està definida a l'entorn però no és un origen públic vàlid, així que el servidor la ignora. Treu-la del teu fitxer d'entorn o posa-li <code>{pattern}</code> o <code>{localhost}</code>.",
  "settings.externalAccess.envMatches":
    "Nota: <code>ISOMUX_PUBLIC_ORIGIN={origin}</code> està definida a l'entorn i coincideix amb aquesta URL pública. La variable d'entorn està obsoleta - treu-la del teu fitxer d'entorn quan hagis desat aquest valor a la configuració de l'oficina.",
  "settings.externalAccess.envConflict":
    "Nota: <code>ISOMUX_PUBLIC_ORIGIN={origin}</code> està definida a l'entorn. En reiniciar tindria prioritat sobre qualsevol valor diferent desat aquí, així que es rebutjarà el desament fins que igualis aquesta URL al valor de l'entorn o treguis la variable de l'entorn del servei.",
  "settings.externalAccess.discardPrompt":
    "Vols descartar els canvis d'accés extern sense desar?",
  "settings.externalAccess.updateFailed":
    "No s'ha pogut actualitzar la configuració",
  "settings.externalAccess.restartNote":
    "Desat. Reinicia isomux perquè la nova interfície d'escolta tingui efecte. Servei d'usuari: <code>systemctl --user restart isomux</code>. Servei del sistema: <code>sudo systemctl restart isomux</code>.",
  "settings.externalAccess.signInAfterRestart":
    "Després del reinici, obre aquesta URL al dispositiu que vulguis fer servir des de l'adreça pública. (Caduca 1 hora després d'emetre-la.)",

  "settings.apiTokens.intro":
    "Fes anar la teva oficina des de scripts i automatitzacions, i llegeix el que responen els teus agents. Un token té les teves mateixes capacitats, tret de canviar qui pot entrar a l'oficina. Mira la <link>guia de l'API per a desenvolupament</link> per a tot el que pot fer un token.",
  "settings.apiTokens.howToUse": "Com es fa servir",
  "settings.apiTokens.namePlaceholder": "Script del portàtil",
  "settings.apiTokens.expiresAfter": "Caduca al cap de",
  "settings.apiTokens.unlimited": "Sense límit",
  "settings.apiTokens.days": "{count} dies",
  "settings.apiTokens.creating": "Creant…",
  "settings.apiTokens.create": "Crea el token",
  "settings.apiTokens.copyNow": "Copia aquest token ara",
  "settings.apiTokens.shownOnce": "No es tornarà a mostrar.",
  "settings.apiTokens.empty": "No hi ha tokens d'API.",
  "settings.apiTokens.neverExpires": "no caduca mai",
  "settings.apiTokens.expiresOn": "caduca el {date}",
  "settings.apiTokens.lastRequest": "Última petició autenticada: {when}",
  "settings.apiTokens.about": "cap al {date}",
  "settings.apiTokens.never": "mai",
  "settings.apiTokens.loadFailed": "No s'han pogut carregar els tokens d'API",
  "settings.apiTokens.createFailed": "No s'ha pogut crear el token d'API",
  "settings.apiTokens.revokeFailed": "No s'ha pogut revocar el token d'API",

  "settings.connections.officeIntro":
    "Els comptes i les variables que fa servir cada agent d'aquesta oficina. Les credencials les guarda el proveïdor, no pas nosaltres.",
  "settings.connections.personalIntro":
    "Els comptes i les variables que fan servir els agents que crees tu. Tenen prioritat sobre els de l'oficina. Les credencials les guarda el proveïdor, no pas nosaltres.",
  "settings.connections.refresh": "Actualitza",
  "settings.connections.refreshing": "Actualitzant…",
  "settings.connections.checkFailed":
    "No s'han pogut comprovar els comptes de proveïdor.",
  "settings.connections.envTitle": "Variables d'entorn",
  "settings.connections.officeVars":
    "Variables per a cada agent d'aquesta oficina",
  "settings.connections.officeVarsHint":
    "Aquestes variables es carreguen per a cada agent tret que una variable d'usuari tingui prioritat.",
  "settings.connections.ownerManaged":
    "Les variables de tota l'oficina les gestiona una persona propietària.",
  "settings.connections.personalVars": "Variables per als agents que creo",
  "settings.connections.personalVarsHint":
    "Aquestes variables es carreguen per als agents que crees i tenen prioritat sobre les de tota l'oficina.",
  "settings.connections.providerKeyNote":
    "Afegeix <code>ANTHROPIC_API_KEY</code>, <code>OPENAI_API_KEY</code> o <code>OPENCODE_API_KEY</code> per fer servir claus d'API del proveïdor. La resta de variables per usuari funcionen igual; per exemple, cada membre pot posar <code>GH_TOKEN</code> perquè els seus agents facin servir les seves pròpies credencials de GitHub. Després fes <code>/clear</code> als agents per aplicar els canvis.",
  "settings.connections.crossLinkFromOffice":
    "Les teves pròpies sessions i variables, que tenen prioritat sobre aquestes, són a <link>Tu → Connexions individuals</link>.",
  "settings.connections.crossLinkFromPersonal":
    "Les sessions i variables de tota l'oficina sobre les quals aquestes tenen prioritat són a <link>Oficina → Connexions de tota l'oficina</link>.",

  "settings.signIn.apiKeyNote":
    "Vols fer servir un token d'API? Mira Configuració → Tu → Connexions individuals.",
  "settings.signIn.scopeOffice":
    "Tota l'oficina: inicia la sessió per a cada agent d'aquesta oficina",
  "settings.signIn.scopePersonal":
    "Individual: inicia la sessió per als agents que creo",
  "settings.signIn.officeHint":
    "Aquesta subscripció es fa servir per a cada agent de l'oficina tret dels que crea un membre que hagi configurat les seves <link>Connexions individuals</link>.",
  "settings.signIn.personalHint":
    "Fes servir un compte a part per als teus agents.",
  "settings.signIn.status": "Estat:",
  "settings.signIn.checking": "Comprovant la connexió…",
  "settings.signIn.waiting": "Esperant el proveïdor…",
  "settings.signIn.connectedAs": "Connectat com a {account}",
  "settings.signIn.connected": "Connectat",
  "settings.signIn.unavailable": "Connexió no disponible",
  "settings.signIn.notConnected": "Sense connectar",
  "settings.signIn.startFailed":
    "No s'ha pogut iniciar la sessió a {provider}.",
  "settings.signIn.submitFailed": "No s'ha pogut enviar el codi de Claude.",
  "settings.signIn.cancelFailed": "No s'ha pogut cancel·lar l'inici de sessió.",
  "settings.signIn.signOutFailed":
    "No s'ha pogut tancar la sessió de {provider}.",
  "settings.signIn.externalWarning":
    "Això tanca la sessió de {provider} en aquesta màquina, fins i tot fora de l'oficina.",
  "settings.signIn.directoryWarning":
    "Això treu la sessió del directori de comptes que vas triar.",
  "settings.signIn.pasteCode": "Enganxa el codi de Claude:",
  "settings.signIn.submitCode": "Envia el codi",
  "settings.signIn.cancelSignIn": "Cancel·la l'inici de sessió",
  "settings.signIn.signingIn": "Iniciant la sessió…",
  "settings.signIn.signIn": "Inicia la sessió",
  "settings.signIn.codexHint":
    "En iniciar la sessió et donem un codi d'un sol ús per escriure'l a la pàgina d'OpenAI. La pàgina s'obre en una pestanya nova; també la pots obrir en qualsevol altre dispositiu.",
  "settings.signIn.claudeHint":
    "Claude s'obre al teu navegador. Quan hi hagis iniciat la sessió, enganxa el codi aquí.",
  "settings.signIn.linkNotOpen": "No s'ha obert l'enllaç?",
  "settings.signIn.linkCopied": "Enllaç copiat",
  "settings.signIn.copyLink": "Copia l'enllaç d'inici de sessió",
  "settings.signIn.enterCode":
    "Escriu aquest codi d'un sol ús a la pàgina d'OpenAI:",
  "settings.signIn.signOutDialog": "Tanca la sessió de {provider}",
  "settings.signIn.signingOut": "Tancant la sessió…",
  "settings.signIn.confirmSignOut": "Confirma el tancament de sessió",
  "settings.signIn.connectedStart":
    "Connectat. Comença una conversa nova per fer servir aquest compte.",
  "settings.signIn.startConversation": "Comença una conversa nova",

  "settings.env.loadFailed": "No s'han pogut carregar les variables",
  "settings.env.saveFailed": "No s'han pogut desar les variables",
  "settings.env.loadingVariables": "Carregant les variables…",
  "settings.env.variableName": "Nom de la variable",
  "settings.env.valueLabel": "Valor de {name}",
  "settings.env.variable": "Variable",
  "settings.env.valuePlaceholder": "Valor",
  "settings.env.remove": "Treu",
  "settings.env.add": "Afegeix una variable",
  "settings.env.hideValues": "Amaga els valors",
  "settings.env.showValues": "Mostra els valors",
  "settings.env.save": "Desa les variables",
  "settings.env.saved": "Variables desades",
  "settings.env.duplicate": "Els noms de les variables no es poden repetir.",

  "settings.memberConnections.title": "Connexions individuals",
  "settings.memberConnections.hint":
    "Variables que aquesta persona ha posat per als seus propis agents. Només els noms - els valors queden privats.",
  "settings.memberConnections.loadFailed":
    "No s'han pogut carregar les variables.",
  "settings.memberConnections.empty": "No hi ha variables.",
  "dialogs.textarea.expand": "Amplia {title}",
  "dialogs.textarea.escCollapse": "Esc per plegar",
  "dialogs.textarea.done": "Fet",

  "dialogs.schedulePrompt.title": "Configuració de les programacions",
  "dialogs.schedulePrompt.rulesHint":
    "(prompt de sistema per a totes les programacions)",
  "dialogs.schedulePrompt.rulesPlaceholder":
    "p. ex. Escriu sempre les troballes en un fitxer markdown. Sigues concís.",
  "dialogs.schedulePrompt.appliedNextRun":
    "S'aplica a l'execució següent; les que ja s'estan executant fan servir la còpia que van capturar.",
  "common.field.engine": "Motor",
  "common.field.model": "Model",
  "common.field.effort": "Esforç de raonament",
  "common.field.sandbox": "Sandbox",
  "common.field.permissionMode": "Mode de permisos",
  "common.field.approvalPolicy": "Política d'aprovació",
  "common.field.workingDirectory": "Directori de treball",

  "common.effort.minimal": "Mínim (només Codex)",
  "common.effort.low": "Baix",
  "common.effort.medium": "Mitjà",
  "common.effort.high": "Alt",
  "common.effort.xhigh": "Molt alt",
  "common.effort.max": "Màxim",
  "common.effort.ultra": "Ultra (només Codex)",

  "common.permission.claudeBypass":
    "Ometre els permisos (s'aprova tot automàticament)",
  "common.permission.codexNever": "No preguntar mai (només el sandbox)",
  "common.sandbox.readOnly":
    "Només lectura (el model pot llegir, mai escriure)",
  "common.sandbox.workspaceWrite":
    "Escriptura a l'espai de treball (només dins del cwd)",
  "common.sandbox.dangerFullAccess": "Perill: accés total (sense sandbox)",

  "common.model.currentOption": "Model actual",
  "common.model.currentIs": "Model actual: {model}.",
  "common.model.checkFailed":
    "No s'han pogut comprovar els models disponibles. Torna a obrir aquest diàleg per provar-ho de nou.",
  "common.model.notOffered":
    "Aquest compte no l'ofereix. Tria un model disponible.",
  "common.model.loading": "Carregant els models disponibles…",
  "common.model.startingOpenCode":
    "OpenCode s'està iniciant. Carregant els models disponibles…",
  "common.model.noneConnected":
    "OpenCode no té models de cap proveïdor connectat per a aquest entorn.",
  "common.model.selectConnected":
    "Tria un model d'OpenCode connectat abans de desar.",
  "common.model.loadFailed": "No s'han pogut carregar els models",
  "common.model.openCodeListFailed":
    "OpenCode no ha pogut llistar els seus models. Torna a obrir aquest diàleg.",
  "common.model.codexNotSignedIn":
    "No has iniciat la sessió a Codex. Obre un agent de Codex i fes clic a la targeta d'inici de sessió que emet, i després torna a obrir aquest diàleg. (O defineix OPENAI_API_KEY al teu entorn.)",
  "common.model.openCodeLoadFailed":
    "No s'han pogut carregar els models d'OpenCode{detail}. Torna a obrir aquest diàleg per provar-ho de nou.",
  "common.model.listLoadFailed":
    "No s'ha pogut carregar la llista de models{detail}. Es mostra la llista de reserva - pot ser que algunes opcions no funcionin al teu compte.",

  "dialogs.schedule.titleNew": "Programació nova",
  "dialogs.schedule.titleEdit": "Editar la programació",
  "dialogs.schedule.namePlaceholder": "Resum diari",
  "dialogs.schedule.daily": "Cada dia",
  "dialogs.schedule.weekly": "Cada setmana",
  "dialogs.schedule.interval": "Cada N minuts",
  "dialogs.schedule.weekday.sunday": "Diumenge",
  "dialogs.schedule.weekday.monday": "Dilluns",
  "dialogs.schedule.weekday.tuesday": "Dimarts",
  "dialogs.schedule.weekday.wednesday": "Dimecres",
  "dialogs.schedule.weekday.thursday": "Dijous",
  "dialogs.schedule.weekday.friday": "Divendres",
  "dialogs.schedule.weekday.saturday": "Dissabte",
  "dialogs.schedule.hour": "Hora (0-23)",
  "dialogs.schedule.minute": "Minut (0-59)",
  "dialogs.schedule.intervalMinutes": "Interval (minuts, mínim 5)",
  "dialogs.schedule.serverLocal": "Les hores són les del servidor.",
  "dialogs.schedule.prompt": "Prompt",
  "dialogs.schedule.promptTitle": "Prompt de la programació",
  "dialogs.schedule.promptPlaceholder":
    "p. ex. \"Resumeix què va aconseguir ahir cada agent.\"",
  "dialogs.schedule.promptEmpty": "El prompt no pot estar buit.",
  "dialogs.schedule.permissionUnattended":
    "Permetre les eines del projecte (sense supervisió)",
  "dialogs.schedule.permissionHintOpenCode":
    "Es permeten les eines de shell i d'edició. Es deneguen la delegació i les preguntes.",
  "dialogs.schedule.permissionHint":
    "Les programacions s'executen sense supervisió - els modes que demanen aprovació humana no estan disponibles.",
  "dialogs.schedule.enabled":
    "Activada (desmarca-la per posar-la en pausa sense eliminar-la)",
  "dialogs.schedule.create": "Crea",

  "dialogs.agent.titleSpawn": "Crear un agent nou",
  "dialogs.agent.titleEdit": "Editar l'agent",
  "dialogs.agent.desk": "Escriptori #{desk}",
  "dialogs.agent.engineBlurb.claude":
    "Funciona amb el teu compte de Claude Code.",
  "dialogs.agent.engineBlurb.codex":
    "Funciona amb el teu compte de ChatGPT.",
  "dialogs.agent.engineBlurb.opencode":
    "Funciona amb els models configurats a través d'OpenCode.",
  "dialogs.agent.template": "Començar amb una plantilla",
  "dialogs.agent.templateHint":
    "Les plantilles omplen els camps de sota. Pots editar totes les propostes.",
  "dialogs.agent.blank": "En blanc",
  "dialogs.agent.blankHint": "Configura l'agent tu mateix.",
  "dialogs.agent.appearance": "Aspecte",
  "dialogs.agent.randomize": "Tria a l'atzar",
  "dialogs.agent.skin": "Pell",
  "dialogs.agent.shirt": "Samarreta",
  "dialogs.agent.hairColor": "Color del cabell",
  "dialogs.agent.hairStyle": "Pentinat",
  "dialogs.agent.hat": "Barret",
  "dialogs.agent.beard": "Barba",
  "dialogs.agent.accessory": "Accessori",
  "dialogs.agent.hairStyle.short": "Curt",
  "dialogs.agent.hairStyle.long": "Llarg",
  "dialogs.agent.hairStyle.ponytail": "Cua",
  "dialogs.agent.hairStyle.bun": "Monyo",
  "dialogs.agent.hairStyle.pigtails": "Cues",
  "dialogs.agent.hairStyle.curly": "Arrissat",
  "dialogs.agent.hairStyle.bald": "Calb",
  "dialogs.agent.hat.none": "Cap",
  "dialogs.agent.hat.cap": "Gorra",
  "dialogs.agent.hat.beanie": "Gorro de llana",
  "dialogs.agent.hat.bow": "Llaç",
  "dialogs.agent.hat.headband": "Cinta",
  "dialogs.agent.accessory.none": "Cap",
  "dialogs.agent.accessory.glasses": "Ulleres",
  "dialogs.agent.accessory.headphones": "Auriculars",
  "dialogs.agent.accessory.bowTie": "Corbatí",
  "dialogs.agent.accessory.tie": "Corbata",
  "dialogs.agent.accessory.earrings": "Arracades",
  "dialogs.agent.beard.none": "Cap",
  "dialogs.agent.beard.stubble": "Incipient",
  "dialogs.agent.beard.full": "Poblada",
  "dialogs.agent.beard.goatee": "Perilla",
  "dialogs.agent.beard.mustache": "Bigoti",
  "dialogs.agent.recent": "Recents",
  "dialogs.agent.manager": "Responsable",
  "dialogs.agent.managerTitle":
    "Es fixa en crear l'agent - el responsable no es pot canviar després.",
  "dialogs.agent.managerNoUser": "(cap usuari assignat)",
  "dialogs.agent.managerUnowned": "(sense propietari)",
  "dialogs.agent.managerHint":
    "Vinculat a l'usuari que el crea. Determina quines variables personals es carreguen a cada sessió (mira Configuració → Tu → Connexions individuals).",
  "dialogs.agent.privileged": "Accés d'operador amb privilegis",
  "dialogs.agent.privilegedHint":
    "Permet a aquest agent dirigir les sessions d'altres agents (reprendre, conversa nova, enviar ara) i gestionar els seus propis cronjobs, amb els permisos per sala de l'usuari que el va crear. Continua actuant com l'agent, mai com l'usuari.",
  "dialogs.agent.privilegedRestart":
    "En desar es reinicia la sessió de l'agent.",
  "dialogs.agent.permission.ask": "Preguntar",
  "dialogs.agent.permission.bypassAll": "Ometre tots els permisos",
  "dialogs.agent.permission.codexUntrusted":
    "No fiable (preguntar a cada eina)",
  "dialogs.agent.permission.codexOnRequest":
    "A petició (el model pregunta quan ho necessita)",
  "dialogs.agent.permission.claudeAuto":
    "Auto (un classificador aprova les accions segures)",
  "dialogs.agent.permission.claudeDefault": "Per defecte (preguntar per a tot)",
  "dialogs.agent.permission.claudeAcceptEdits":
    "Acceptar les edicions (aprovar els canvis en fitxers)",
  "dialogs.agent.modelTier.free":
    "Gratis (el proveïdor pot fer servir el trànsit per entrenar)",
  "dialogs.agent.modelTier.payg": "Pagament per ús (crèdits d'OpenCode)",
  "dialogs.agent.modelTier.subscription": "Subscripció (OpenCode Go)",
  "dialogs.agent.memoryHint":
    "(fets duradors d'aquest agent; línies en brut; {size} / {cap})",
  "dialogs.agent.memoryTitle": "Memòria de l'agent",
  "dialogs.agent.memoryPlaceholder":
    "Alguna memòria rellevant per a aquest agent",
  "dialogs.agent.customInstructions": "Instruccions personalitzades",
  "dialogs.agent.optional": "(opcional)",
  "dialogs.agent.customInstructionsHint":
    "Prompt de sistema personal per a aquest agent. Executa /isomux-system-prompt en un xat per veure el prompt de sistema complet de l'agent.",
  "dialogs.agent.customInstructionsPlaceholder":
    "p. ex. \"Ets un especialista en backend. Escriu sempre tests.\"",
  "dialogs.agent.systemPromptHint":
    "Executa <code>/isomux-system-prompt</code> en un xat per veure el prompt de sistema complet de l'agent.",
  "dialogs.agent.revive": "Reactiva un agent aturat",
  "dialogs.agent.reviving": "Reactivant…",
  "dialogs.agent.reviveFailed": "No s'ha pogut reactivar",
  "dialogs.agent.moveToRoom": "Moure a la sala",
  "dialogs.agent.invalidDirectory": "Directori no vàlid",
  "dialogs.agent.staleInstructions":
    "Les instruccions personalitzades han canviat des que vas obrir això - torna a obrir el diàleg per editar la versió més recent.",
  "dialogs.agent.spawn": "Crea",

  "templates.moneyPlanner.label": "Planificador de finances",
  "templates.moneyPlanner.description":
    "Planifica despeses, estalvi, objectius i decisions financeres.",
  "templates.sideProjectBuilder.label": "Creador de projectes paral·lels",
  "templates.sideProjectBuilder.description":
    "Converteix una idea vaga en un producte petit que arriba a publicar-se.",
  "templates.healthNavigator.label": "Guia de salut",
  "templates.healthNavigator.description":
    "Organitza la informació de salut i prepara les consultes.",
  "templates.lifeCoach.label": "Coach de vida",
  "templates.lifeCoach.description":
    "Aclareix objectius, tria els passos següents i revisa el progrés.",
  "templates.researchAnalyst.label": "Analista de recerca",
  "templates.researchAnalyst.description":
    "Investiga preguntes i produeix informes a punt per decidir.",
  "templates.personalSiteBuilder.label": "Creador de llocs personals",
  "templates.personalSiteBuilder.description":
    "Dissenya, construeix i publica un lloc web personal.",
  "templates.cityGuide.label": "Guia de la ciutat",
  "templates.cityGuide.description":
    "Descobreix llocs i planifica segons com explores.",
  "templates.todoListAssistant.label": "Assistent de tasques pendents",
  "templates.todoListAssistant.description":
    "Converteix els compromisos en un sistema personal que continua sent útil.",
  "templates.codeReviewer.label": "Revisor de codi",
  "templates.codeReviewer.description":
    "Troba els defectes que importen i explica solucions precises.",
  "templates.relationshipAdvisor.label": "Conseller de relacions",
  "templates.relationshipAdvisor.description":
    "Pensa a fons la comunicació, les necessitats i els passos següents.",
  "templates.jobSearchCoach.label": "Coach de cerca de feina",
  "templates.jobSearchCoach.description":
    "Enfoca la cerca i millora les candidatures i les entrevistes.",
  "templates.tripPlanner.label": "Planificador de viatges",
  "templates.tripPlanner.description":
    "Construeix viatges pràctics segons els teus interessos i els teus límits.",
};
