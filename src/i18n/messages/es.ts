/**
 * Spanish message catalog. Mirrors every key in ./en.
 */
import type { SeedMessageKey } from "./en.js";

export const es: Record<SeedMessageKey, string> = {
  "common.cancel": "Cancelar",
  "common.allow": "Permitir",
  "common.confirm": "Confirmar",
  "common.ok": "Aceptar",
  "common.save": "Guardar",
  "common.close": "Cerrar",
  "common.delete": "Eliminar",
  "common.remove": "Quitar",
  "common.retry": "Reintentar",
  "common.loading": "Cargando…",
  "common.error": "Error",
  "common.thinking": "Pensando…",
  "settings.appearance.language.title": "Idioma",
  "settings.appearance.language.description": "Elige el idioma usado en toda la app. Los cambios se aplican de inmediato.",
  "settings.appearance.language.saved": "Idioma actualizado.",
  "mainDialog.restart": "Reiniciar",
  "mainDialog.updateApplyTitle": "Aplicar actualización",
  "mainDialog.updateRestartMessage": "LVIS se reiniciará en v{version}.",
  "mainDialog.updateRestartDetail": "El trabajo en curso finalizará. ¿Quieres continuar?",
  "mainDialog.attachTitle": "Seleccionar archivos adjuntos",
  "mainDialog.pluginPickFolderTitle": "Seleccionar carpetas para {plugin}",
  "mainDialog.installLocalPluginTitle": "Instalar plugin local (desarrollador)",
  "mainDialog.installLocalPluginMessage": "Selecciona la carpeta de build que contiene plugin.json",
  "mainDialog.unauthorizedFrame": "Marco no autorizado.",
  "mainDialog.pluginDisableNotPermitted": "Este complemento está gestionado por tu organización y no se puede desactivar.",
  "mainDialog.noPersonasAvailable": "No hay personas disponibles",
  "mainDialog.exportConversationTitle": "Exportar conversación",
  "mainDialog.importConversationTitle": "Importar conversación",

  // ── E4 — Inicio / atajos globales ─────────────────────────────────
  "settingsContent.tabStartup": "Inicio",
  "startupTab.title": "Inicio y atajos",
  "startupTab.description":
    "Configura un atajo global para mostrar/ocultar la ventana y elige si LVIS se inicia al iniciar sesión.",
  "startupTab.shortcutSectionTitle": "Atajo global",
  "startupTab.shortcutSectionDesc":
    "Una combinación de teclas de todo el sistema que muestra u oculta la ventana de LVIS desde cualquier lugar.",
  "startupTab.shortcutEnabledLabel": "Activar atajo global",
  "startupTab.shortcutEnabledHint": "Registrar el atajo en el sistema operativo.",
  "startupTab.shortcutAcceleratorLabel": "Atajo para mostrar/ocultar la ventana",
  "startupTab.shortcutRecord": "Grabar",
  "startupTab.shortcutClear": "Borrar",
  "startupTab.shortcutCapturing": "Pulsa una combinación de teclas…",
  "startupTab.shortcutUnset": "Sin configurar",
  "startupTab.shortcutEnabledNoAccelerator":
    "El atajo está activado pero no hay combinación de teclas configurada. Graba una para activarlo.",
  "startupTab.shortcutRegisterFailedTitle": "Error al registrar el atajo",
  "startupTab.shortcutRegisterFailedBody":
    "{accelerator} ya está en uso por otra aplicación. Elige otra combinación.",
  "startupTab.renderingSectionTitle":
    "Representación",
  "startupTab.renderingSectionDesc":
    "Controla si LVIS usa la tarjeta gráfica para dibujar la interfaz.",
  "startupTab.hardwareAccelerationLabel":
    "Usar aceleración por hardware",
  "startupTab.hardwareAccelerationHelp":
    "Se aplica la próxima vez que se inicie LVIS. Desactívala si la ventana se queda en negro, parpadea o la aplicación se cierra al dibujar: en algunos equipos gestionados y escritorios virtuales los controladores gráficos no pueden con ella. Por eso viene desactivada de forma predeterminada en Windows y Linux.",
  "startupTab.hardwareAccelerationEnvForced":
    "La variable de entorno {envVar} está activando esto ahora mismo, independientemente de lo que se guarde aquí.",
  "startupTab.corpCaSectionTitle":
    "Certificado de red corporativa",
  "startupTab.corpCaSectionDesc":
    "Para redes que inspeccionan el tráfico TLS con un certificado raíz emitido por la empresa.",
  "startupTab.corpCaEnabledLabel":
    "Confiar en el certificado raíz corporativo",
  "startupTab.corpCaEnabledHelp":
    "Se aplica la próxima vez que se inicie LVIS. Para navegar, LVIS confía en los certificados en los que confía el sistema operativo, pero las llamadas al modelo, las peticiones al marketplace y la comprobación de actualizaciones se verifican por separado y no lo hacen. En una red que inspecciona el tráfico TLS, esas fallan con un error de certificado mientras las páginas normales cargan bien; esto es lo que lo soluciona. Déjalo activado si tienes dudas: en un equipo sin ese certificado no encuentra nada y no cambia nada.",
  "startupTab.corpCaEnabledEnvForced":
    "La variable de entorno {envVar} está desactivando esto ahora mismo, independientemente de lo que se guarde aquí.",
  "startupTab.corpCaCommonNameLabel":
    "Nombre del certificado",
  "startupTab.corpCaCommonNameHelp":
    "El nombre común (CN) del certificado raíz de tu empresa, tal como aparece en el almacén de confianza del sistema. El valor predeterminado de abajo es solo un marcador: pregunta a tu departamento de TI el nombre real si los errores de certificado continúan. Basta con una parte del nombre.",
  "startupTab.corpCaCommonNameEnvForced":
    "La variable de entorno {envVar} está proporcionando este nombre ahora mismo, en lugar del valor guardado aquí.",
  "startupTab.corpCaDebugLabel":
    "Registrar los detalles de la búsqueda de certificados",
  "startupTab.corpCaDebugHelp":
    "Escribe en el registro de la aplicación qué se buscó y qué se encontró. Actívalo solo mientras diagnosticas un problema de certificados.",
  "startupTab.corpCaDebugEnvForced":
    "La variable de entorno {envVar} está activando esto ahora mismo, independientemente de lo que se guarde aquí.",
  "startupTab.launchSectionTitle": "Iniciar al arrancar",
  "startupTab.launchSectionDesc":
    "Controla si LVIS se inicia automáticamente cuando inicias sesión en tu equipo.",
  "startupTab.launchAtStartupLabel": "Iniciar LVIS al iniciar sesión",
  "startupTab.launchAtStartupHint": "Inicia LVIS automáticamente tras iniciar sesión. (Solo app instalada.)",
  "startupTab.launchMinimizedLabel": "Iniciar oculto en la bandeja",
  "startupTab.launchMinimizedHint": "Al iniciar con el sistema, arranca minimizado en la bandeja sin abrir ventana.",
  "startupTab.launchRegisterFailedTitle": "No se pudo aplicar el inicio al arrancar",
  "startupTab.shutdownTimeoutLabel":
    "Tiempo permitido para la limpieza al salir",
  "startupTab.shutdownTimeoutHelp":
    "Al salir, LVIS detiene sus rutinas, complementos y procesos en segundo plano y guarda la disposición de las ventanas antes de cerrarse. Si no termina dentro de este tiempo, se cierra igualmente y se descarta lo que aún se estuviera escribiendo. Auméntalo si un complemento necesita más tiempo para cerrarse; redúcelo si salir se siente lento.",
  "startupTab.shutdownTimeoutEnvForced":
    "La variable de entorno {envVar} está proporcionando este valor ahora mismo, en lugar del valor guardado aquí.",
  "startupTab.shutdownTimeoutSeconds": "{seconds} segundos",
  "startupTab.shutdownTimeoutSecondsDefault": "{seconds} segundos (predeterminado)",
  "startupTab.launchRegisterFailedBody":
    "LVIS no pudo registrarse para iniciarse al iniciar sesión en este sistema. Abre Configuración para volver a intentarlo.",
};
