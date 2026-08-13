import 'dart:io';

import 'package:device_info_plus/device_info_plus.dart';

import '../../features/spike/domain/models.dart';

/// Sin el modelo de dispositivo, los números del spike no se pueden interpretar:
/// 900 ms en un Android de gama baja codificando 1080p por software no significa
/// lo mismo que 900 ms en un iPhone reciente.
Future<DeviceInfo> readDeviceInfo({required String appVersion}) async {
  final plugin = DeviceInfoPlugin();

  if (Platform.isAndroid) {
    final a = await plugin.androidInfo;
    return DeviceInfo(
      model: '${a.manufacturer} ${a.model}',
      os: 'Android',
      osVersion: '${a.version.release} (API ${a.version.sdkInt})',
      appVersion: appVersion,
      isPhysicalDevice: a.isPhysicalDevice,
    );
  }

  if (Platform.isIOS) {
    final i = await plugin.iosInfo;
    return DeviceInfo(
      model: i.utsname.machine,
      os: 'iOS',
      osVersion: i.systemVersion,
      appVersion: appVersion,
      isPhysicalDevice: i.isPhysicalDevice,
    );
  }

  return DeviceInfo(
    model: 'unknown',
    os: Platform.operatingSystem,
    osVersion: Platform.operatingSystemVersion,
    appVersion: appVersion,
    isPhysicalDevice: false,
  );
}
