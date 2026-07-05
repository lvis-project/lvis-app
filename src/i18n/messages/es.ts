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
  "mainDialog.installLocalPluginTitle": "Instalar plugin local (desarrollador)",
  "mainDialog.installLocalPluginMessage": "Selecciona la carpeta de build que contiene plugin.json",
  "mainDialog.unauthorizedFrame": "Marco no autorizado.",
  "mainDialog.noPersonasAvailable": "No hay personas disponibles",
  "mainDialog.exportConversationTitle": "Exportar conversación",

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
  "startupTab.launchSectionTitle": "Iniciar al arrancar",
  "startupTab.launchSectionDesc":
    "Controla si LVIS se inicia automáticamente cuando inicias sesión en tu equipo.",
  "startupTab.launchAtStartupLabel": "Iniciar LVIS al iniciar sesión",
  "startupTab.launchAtStartupHint": "Inicia LVIS automáticamente tras iniciar sesión. (Solo app instalada.)",
  "startupTab.launchMinimizedLabel": "Iniciar oculto en la bandeja",
  "startupTab.launchMinimizedHint": "Al iniciar con el sistema, arranca minimizado en la bandeja sin abrir ventana.",
};
