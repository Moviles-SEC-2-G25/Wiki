// Analysis probe (NOT part of the project): mounts the real QuestDetailView
// with a GPS quest and a known user position, feeds N synthetic compass
// events through the real 'hemanthraj/flutter_compass' EventChannel, and
// counts widget rebuilds and RenderObject paints per event using Flutter's
// own debug hooks (debugOnRebuildDirtyWidget / debugOnProfilePaint).
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:geolocator/geolocator.dart';
import 'package:provider/provider.dart';
import 'package:sidequests/analytics/analytics_event_sink.dart';
import 'package:sidequests/analytics/analytics_tracker.dart';
import 'package:sidequests/core/verification/step_verification_strategy.dart';
import 'package:sidequests/data/context/context_manager.dart';
import 'package:sidequests/data/services/battery_monitor.dart';
import 'package:sidequests/data/services/location_check_in_service.dart';
import 'package:sidequests/data/services/location_service.dart';
import 'package:sidequests/data/services/reverse_geocoding_service.dart';
import 'package:sidequests/data/services/step_counter_service.dart';
import 'package:sidequests/data/services/weather_service.dart';
import 'package:sidequests/models/quest.dart';
import 'package:sidequests/models/quest_step.dart';
import 'package:sidequests/models/weather_snapshot.dart';
import 'package:sidequests/repository/quest_repository.dart';
import 'package:sidequests/view/quests/quest_detail_view.dart';
import 'package:sidequests/viewmodel/quests/quest_view_model.dart';

const _events = 100;

// Same shape as the seeded 'botanical-garden' quest (gps, with coordinates).
const _quest = Quest(
  id: 'botanical-garden',
  title: 'Explore the Botanical Garden',
  description:
      'A slow wander through the conservatory — spot unfamiliar plants, find the '
      'Japanese garden, and leave with one photo of a plant you had never seen.',
  category: 'Nature',
  emoji: '🌿',
  durationMinutes: 45,
  difficulty: 'easy',
  locationMode: 'gps',
  socialLevel: 'solo',
  locationName: 'Jardín Botánico José Celestino Mutis',
  latitude: 4.6686,
  longitude: -74.0986,
);

final _steps = [
  for (var i = 0; i < 4; i++)
    QuestStep.fromJson({
      'id': i,
      'quest_id': 'botanical-garden',
      'step_order': i,
      'title': 'Step $i',
      'description': 'Description $i',
      'verification_type': 'none',
    }),
];

class _FakeLocation extends LocationService {
  @override
  Future<Position?> getCurrentPosition({LocationAccuracy accuracy = LocationAccuracy.medium}) async =>
      null;
}

class _FakeWeather extends WeatherService {
  @override
  Future<WeatherSnapshot?> fetch(double latitude, double longitude) async => WeatherSnapshot(
    weatherCode: 1,
    temperatureC: 17.6,
    precipitationProbabilityNext3h: const [10, 20, 30],
    fetchedAt: DateTime.now(),
  );
}

class _FakeGeo implements ReverseGeocodingService {
  @override
  Future<String?> addressFor(double latitude, double longitude) async =>
      'Avenida Calle 63 # 68-95, Bogotá';

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FullBattery extends BatteryMonitor {
  @override
  Future<bool> isLow() async => false;
}

class _NullSink implements AnalyticsEventSink {
  @override
  Future<void> insertAnalyticsEvent(Map<String, dynamic> event) async {}
}

class _FakeQuestRepository implements QuestRepository {
  @override
  Future<List<QuestStep>> getSteps(String questId) async => _steps;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  testWidgets('compass: rebuilds and paints per compass event on QuestDetailView', (tester) async {
    tester.view.physicalSize = const Size(1080, 2400);
    tester.view.devicePixelRatio = 2.75;
    addTearDown(tester.view.reset);

    MockStreamHandlerEventSink? compassSink;
    tester.binding.defaultBinaryMessenger.setMockStreamHandler(
      const EventChannel('hemanthraj/flutter_compass'),
      MockStreamHandler.inline(onListen: (_, sink) {
        compassSink = sink;
      }),
    );

    final contextManager = ContextManager(locationService: _FakeLocation(), batteryMonitor: _FullBattery());
    final viewModel = QuestViewModel(
      _FakeQuestRepository(),
      contextManager,
      AnalyticsTracker(eventSink: _NullSink(), contextManager: contextManager, sessionId: 'unused'),
      'user-1',
      stepCounter: StepCounterService(requestAccess: () async => StepCounterStatus.unavailable),
      locationCheckIn: LocationCheckInService(
        requestAccess: () async => LocationAccess.granted,
        isLowBattery: () async => false,
        isOffline: () async => false,
        offlineChanges: () => const Stream.empty(),
        positions: (_, _) => const Stream.empty(),
      ),
    )
      // The user already shared their location (Cerca tab / "Activar").
      ..userLatitude = 4.6382
      ..userLongitude = -74.0841;

    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<QuestViewModel>.value(value: viewModel),
          Provider<LocationService>.value(value: _FakeLocation()),
          Provider<WeatherService>.value(value: _FakeWeather()),
          Provider<ReverseGeocodingService>.value(value: _FakeGeo()),
        ],
        child: const MaterialApp(home: QuestDetailView(quest: _quest)),
      ),
    );
    for (var i = 0; i < 5; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(compassSink, isNotNull, reason: 'the compass stream was never listened to');

    // First reading: leaves "Calibrando brújula…" and shows the arrow.
    compassSink!.success(<double>[10, 10, 15]);
    await tester.pump(const Duration(milliseconds: 32));
    expect(find.text('Sigue la flecha'), findsOneWidget);

    var totalRenderObjects = 0;
    void countRenderObjects(RenderObject node) {
      totalRenderObjects++;
      node.visitChildren(countRenderObjects);
    }
    countRenderObjects(tester.binding.renderViews.first);

    var builds = 0;
    var paints = 0;
    final builtTypes = <String, int>{};
    final paintedTypes = <String, int>{};
    debugOnRebuildDirtyWidget = (element, _) {
      builds++;
      final type = element.widget.runtimeType.toString();
      builtTypes[type] = (builtTypes[type] ?? 0) + 1;
    };
    debugOnProfilePaint = (renderObject) {
      paints++;
      final type = renderObject.runtimeType.toString();
      paintedTypes[type] = (paintedTypes[type] ?? 0) + 1;
    };

    for (var i = 1; i <= _events; i++) {
      final heading = (10 + i * 0.7) % 360; // a phone lying still: small drift
      compassSink!.success(<double>[heading, heading, 15]);
      await tester.pump(const Duration(milliseconds: 32));
    }

    debugOnRebuildDirtyWidget = null;
    debugOnProfilePaint = null;

    String top(Map<String, int> m) {
      final entries = m.entries.toList()..sort((a, b) => b.value.compareTo(a.value));
      return entries.take(12).map((e) => '    ${e.key}: ${(e.value / _events).toStringAsFixed(1)}').join('\n');
    }

    // ignore: avoid_print
    print('''
=== QuestDetailView + compass probe ($_events events, 1 frame each) ===
RenderObjects in the tree:            $totalRenderObjects
Widget rebuilds   total / per event:  $builds / ${(builds / _events).toStringAsFixed(1)}
RenderObject paints total / per event: $paints / ${(paints / _events).toStringAsFixed(1)}
Top rebuilt widget types per event:
${top(builtTypes)}
Top painted RenderObject types per event:
${top(paintedTypes)}
''');
  });
}
