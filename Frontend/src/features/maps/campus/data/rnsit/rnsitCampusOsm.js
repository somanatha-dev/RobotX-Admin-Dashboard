/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RNSIT CAMPUS — the OpenStreetMap export, verbatim
 *
 * This is the CONTENT of `data/rnsit-campus-osm.geojson` re-exported as an ES
 * module, and nothing else. Not a cleaned copy, not a corrected copy: every
 * coordinate, every tag and every OSM id is exactly what the Overpass Turbo
 * export contained. Classification, the height policy and de-duplication all
 * happen downstream in `osm/osmCampusImport.js`, where each decision is visible
 * and testable — none of it happens here.
 *
 * ── Why a .js mirror of a .geojson file exists ────────────────────────────
 * `campusRegistry.resolveCampusDefinition` is a synchronous pure function,
 * called from a `useMemo` and from architecture tests that run under plain
 * `node --test` with no bundler. A `.geojson` import would need Vite's JSON
 * handling in one environment and an import attribute in the other. A `.js`
 * module needs neither and stays synchronous, so the campus definition remains
 * a value rather than a promise.
 *
 * The two files are asserted equivalent by
 * `__architecture__/campusOsmImport.test.mjs`, so this mirror cannot drift from
 * the artefact it was generated from. Regenerate it; never hand-edit it.
 *
 * ── Licence ───────────────────────────────────────────────────────────────
 * © OpenStreetMap contributors, made available under the Open Database Licence
 * (ODbL). Retrieved through Overpass Turbo — the export carries its own
 * `timestamp` and `copyright` fields, and both are preserved below.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** The Overpass Turbo export, verbatim. This is source data — treat it as read-only. */
export const RNSIT_CAMPUS_OSM = {
  "type": "FeatureCollection",
  "generator": "overpass-turbo",
  "copyright": "The data included in this document is from www.openstreetmap.org. The data is made available under ODbL.",
  "timestamp": "2026-08-23T04:59:06Z",
  "features": [
    {
      "type": "Feature",
      "properties": {
        "@id": "way/151617521",
        "building": "commercial",
        "sport": "cricket;football",
        "surface": "grass"
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              77.5181465,
              12.9021655
            ],
            [
              77.5178649,
              12.9009027
            ],
            [
              77.5187055,
              12.9007246
            ],
            [
              77.5188942,
              12.9015709
            ],
            [
              77.5189871,
              12.9019874
            ],
            [
              77.5181465,
              12.9021655
            ]
          ]
        ]
      },
      "id": "way/151617521"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/204638927",
        "air_conditioning": "no",
        "amenity": "bank",
        "atm": "yes",
        "brand": "Canara Bank",
        "brand:en": "Canara Bank",
        "brand:hi": "केनरा बैंक",
        "brand:kn": "ಕೆನರಾ ಬ್ಯಾಂಕ್",
        "brand:pa": "ਕੇਨਰਾ ਬੈਂਕ",
        "brand:pnb": "کینرا بینک",
        "brand:ur": "کینرا بینک",
        "brand:wikidata": "Q2003777",
        "building": "yes",
        "drive_through": "no",
        "name": "Canara Bank",
        "name:en": "Canara Bank",
        "name:hi": "केनरा बैंक",
        "name:kn": "ಕೆನರಾ ಬ್ಯಾಂಕ್",
        "name:pa": "ਕੇਨਰਾ ਬੈਂਕ",
        "name:pnb": "کینرا بینک",
        "name:ur": "کینرا بینک",
        "opening_hours": "24/7"
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              77.5190099,
              12.9021416
            ],
            [
              77.5189992,
              12.9020931
            ],
            [
              77.5190412,
              12.9020843
            ],
            [
              77.5190519,
              12.9021328
            ],
            [
              77.5190099,
              12.9021416
            ]
          ]
        ]
      },
      "id": "way/204638927"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/204638928",
        "amenity": "food_court",
        "building": "yes",
        "internet_access": "no",
        "name": "Canteen",
        "opening_hours": "Mo-Sat 08:00 to 16:00"
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              77.5192591,
              12.9023347
            ],
            [
              77.5192457,
              12.9022802
            ],
            [
              77.5192339,
              12.9022317
            ],
            [
              77.519574,
              12.9021528
            ],
            [
              77.5195934,
              12.902232
            ],
            [
              77.5193186,
              12.9022958
            ],
            [
              77.5193244,
              12.9023195
            ],
            [
              77.5192591,
              12.9023347
            ]
          ]
        ]
      },
      "id": "way/204638928"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/204638929",
        "building": "yes",
        "building:levels": "3",
        "name": "CSE, ISE & CSDS Department"
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              77.517128,
              12.9022593
            ],
            [
              77.5170904,
              12.9020832
            ],
            [
              77.5178711,
              12.9019246
            ],
            [
              77.517893,
              12.9020271
            ],
            [
              77.5179087,
              12.9021007
            ],
            [
              77.5175252,
              12.902181
            ],
            [
              77.517128,
              12.9022593
            ]
          ]
        ]
      },
      "id": "way/204638929"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/204638932",
        "building": "yes",
        "building:levels": "3",
        "name": "ECE Department"
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              77.5175504,
              12.9024564
            ],
            [
              77.5175485,
              12.9022717
            ],
            [
              77.5180474,
              12.9022667
            ],
            [
              77.5180484,
              12.9023674
            ],
            [
              77.5180493,
              12.9024513
            ],
            [
              77.5177366,
              12.9024545
            ],
            [
              77.5175504,
              12.9024564
            ]
          ]
        ]
      },
      "id": "way/204638932"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/204638933",
        "amenity": "fountain",
        "drinking_water": "no",
        "fountain": "decorative",
        "lit": "no",
        "name": "Fountain"
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              77.5180048,
              12.9020463
            ],
            [
              77.5179905,
              12.9020417
            ],
            [
              77.5179809,
              12.9020254
            ],
            [
              77.5179785,
              12.9020044
            ],
            [
              77.5179817,
              12.9019874
            ],
            [
              77.5179937,
              12.9019788
            ],
            [
              77.5180048,
              12.9019812
            ],
            [
              77.5180159,
              12.9019936
            ],
            [
              77.5180215,
              12.9020099
            ],
            [
              77.5180207,
              12.9020269
            ],
            [
              77.5180136,
              12.9020378
            ],
            [
              77.5180048,
              12.9020463
            ]
          ]
        ]
      },
      "id": "way/204638933"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/204638934",
        "building": "yes",
        "name": "Hostel"
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              77.5171261,
              12.9019407
            ],
            [
              77.5168386,
              12.901238
            ],
            [
              77.5169915,
              12.9011786
            ],
            [
              77.517279,
              12.9018812
            ],
            [
              77.5171261,
              12.9019407
            ]
          ]
        ]
      },
      "id": "way/204638934"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/204638935",
        "building": "yes",
        "name": "Hostel"
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              77.5171049,
              12.9024917
            ],
            [
              77.5171104,
              12.9023557
            ],
            [
              77.5173021,
              12.902363
            ],
            [
              77.5174863,
              12.9023701
            ],
            [
              77.5174808,
              12.9025061
            ],
            [
              77.5171049,
              12.9024917
            ]
          ]
        ]
      },
      "id": "way/204638935"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/204638936",
        "building": "dormitory",
        "name": "Hostel"
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              77.5178118,
              12.9017577
            ],
            [
              77.5176679,
              12.9010591
            ],
            [
              77.5178075,
              12.9010318
            ],
            [
              77.5178568,
              12.901271
            ],
            [
              77.5179217,
              12.9015862
            ],
            [
              77.5179514,
              12.9017304
            ],
            [
              77.5178118,
              12.9017577
            ]
          ]
        ]
      },
      "id": "way/204638936"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/204638937",
        "building": "yes",
        "building:levels": "2",
        "name": "Main Building",
        "name:kn": "ಮುಖ್ಯ ಕಟ್ಟಡ",
        "website": "https://www.rnsit.ac.in/"
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              77.5181508,
              12.9023649
            ],
            [
              77.5181277,
              12.9022574
            ],
            [
              77.5189409,
              12.9020917
            ],
            [
              77.5189628,
              12.9021936
            ],
            [
              77.5186421,
              12.9022589
            ],
            [
              77.51865,
              12.9023278
            ],
            [
              77.518558,
              12.9023538
            ],
            [
              77.5185432,
              12.902285
            ],
            [
              77.5181508,
              12.9023649
            ]
          ]
        ]
      },
      "id": "way/204638937"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/204638938",
        "amenity": "place_of_worship",
        "building": "yes",
        "denomination": "shaivist",
        "name": "Shiva Temple",
        "name:kn": "ಶಿವ ದೇವಸ್ಥಾನ",
        "religion": "hindu"
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              77.5184408,
              12.8999116
            ],
            [
              77.5184852,
              12.9000492
            ],
            [
              77.5182258,
              12.9001288
            ],
            [
              77.5181813,
              12.8999911
            ],
            [
              77.5184408,
              12.8999116
            ]
          ]
        ]
      },
      "id": "way/204638938"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/204638939",
        "amenity": "toilets",
        "fee": "no",
        "female": "yes",
        "male": "yes",
        "name:kn": "ಶೌಚಾಲಯ"
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              77.5183592,
              12.9025234
            ],
            [
              77.5184299,
              12.9025149
            ],
            [
              77.5184347,
              12.9025524
            ],
            [
              77.518364,
              12.9025609
            ],
            [
              77.5183592,
              12.9025234
            ]
          ]
        ]
      },
      "id": "way/204638939"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/204638940",
        "amenity": "theatre"
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              77.518494,
              12.9021654
            ],
            [
              77.5184813,
              12.9021072
            ],
            [
              77.5186101,
              12.9020806
            ],
            [
              77.5186228,
              12.9021388
            ],
            [
              77.518494,
              12.9021654
            ]
          ]
        ]
      },
      "id": "way/204638940"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/204638941",
        "building": "yes",
        "building:levels": "3",
        "name": "RNSIT Mec and EEE Department"
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              77.5191789,
              12.9018735
            ],
            [
              77.5190799,
              12.9016084
            ],
            [
              77.5189612,
              12.9012904
            ],
            [
              77.5192475,
              12.9011888
            ],
            [
              77.5194652,
              12.901772
            ],
            [
              77.5191789,
              12.9018735
            ]
          ]
        ]
      },
      "id": "way/204638941"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/204638942",
        "building": "yes"
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              77.5187847,
              12.9005972
            ],
            [
              77.5187114,
              12.9003842
            ],
            [
              77.5186079,
              12.9000832
            ],
            [
              77.5188221,
              12.9000131
            ],
            [
              77.518999,
              12.9005272
            ],
            [
              77.5187847,
              12.9005972
            ]
          ]
        ]
      },
      "id": "way/204638942"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/204638943",
        "building": "yes",
        "building:levels": "3",
        "name": "RNSIT MBA block"
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              77.5190138,
              12.9011913
            ],
            [
              77.5189417,
              12.9009884
            ],
            [
              77.5188333,
              12.9006838
            ],
            [
              77.5190397,
              12.9006141
            ],
            [
              77.5192202,
              12.9011215
            ],
            [
              77.5190138,
              12.9011913
            ]
          ]
        ]
      },
      "id": "way/204638943"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/204638954",
        "amenity": "parking"
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              77.5195065,
              12.9021246
            ],
            [
              77.5194338,
              12.9018477
            ],
            [
              77.5194716,
              12.9018383
            ],
            [
              77.5195443,
              12.9021152
            ],
            [
              77.5195065,
              12.9021246
            ]
          ]
        ]
      },
      "id": "way/204638954"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/204638955",
        "amenity": "parking"
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              77.5195704,
              12.9021083
            ],
            [
              77.5194872,
              12.9018285
            ],
            [
              77.5195228,
              12.9018185
            ],
            [
              77.519606,
              12.9020983
            ],
            [
              77.5195704,
              12.9021083
            ]
          ]
        ]
      },
      "id": "way/204638955"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/347078123",
        "building": "yes"
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              77.51965,
              12.9022798
            ],
            [
              77.5196149,
              12.9021746
            ],
            [
              77.5196723,
              12.9021564
            ],
            [
              77.5197074,
              12.9022616
            ],
            [
              77.51965,
              12.9022798
            ]
          ]
        ]
      },
      "id": "way/347078123"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/348134468",
        "building": "yes"
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              77.5166633,
              12.9006363
            ],
            [
              77.5165483,
              12.9003452
            ],
            [
              77.5167231,
              12.9002796
            ],
            [
              77.5168381,
              12.9005708
            ],
            [
              77.5166633,
              12.9006363
            ]
          ]
        ]
      },
      "id": "way/348134468"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/348135401",
        "building": "yes"
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              77.5168263,
              12.9010427
            ],
            [
              77.5166713,
              12.9006597
            ],
            [
              77.5168413,
              12.9005944
            ],
            [
              77.5169962,
              12.9009774
            ],
            [
              77.5168263,
              12.9010427
            ]
          ]
        ]
      },
      "id": "way/348135401"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/1120154292",
        "addr:city": "Bangalore",
        "addr:country": "IN",
        "addr:housename": "RNSIT",
        "addr:postcode": "560098",
        "addr:street": "Uttarahalli Kengeri Main Road",
        "alt_name": "RNSIT",
        "amenity": "college",
        "contact:fax": "+918028611882",
        "contact:phone": "+918028611880",
        "contact:website": "http://rnsit.ac.in/",
        "name": "RNS Institute of Technology",
        "source": "Local knowledge",
        "wikidata": "Q7277277",
        "wikipedia": "en:RNS Institute of Technology"
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              77.5187278,
              12.8996306
            ],
            [
              77.5188634,
              12.8995965
            ],
            [
              77.5190055,
              12.9002031
            ],
            [
              77.5197566,
              12.9022816
            ],
            [
              77.5189935,
              12.9024215
            ],
            [
              77.5190015,
              12.9024816
            ],
            [
              77.518398,
              12.9025796
            ],
            [
              77.5175585,
              12.9025509
            ],
            [
              77.5170891,
              12.9025365
            ],
            [
              77.5170676,
              12.9020254
            ],
            [
              77.5167149,
              12.9010515
            ],
            [
              77.5162806,
              12.9000909
            ],
            [
              77.5156838,
              12.9002873
            ],
            [
              77.515575,
              12.9000645
            ],
            [
              77.515009,
              12.8991128
            ],
            [
              77.516385,
              12.8988932
            ],
            [
              77.5165634,
              12.9000566
            ],
            [
              77.5170747,
              12.8999947
            ],
            [
              77.5187278,
              12.8996306
            ]
          ]
        ]
      },
      "id": "way/1120154292"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/1224937858",
        "historic": "memorial",
        "material": "stone",
        "memorial": "statue",
        "name": "RN Shetty Statue",
        "subject": "RN Shetty",
        "subject:wikidata": "Q7273875"
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              77.5183405,
              12.9009952
            ],
            [
              77.5182453,
              12.9010227
            ],
            [
              77.5181796,
              12.9009534
            ],
            [
              77.5182091,
              12.900858
            ],
            [
              77.5183003,
              12.9008344
            ],
            [
              77.5183647,
              12.900905
            ],
            [
              77.5183405,
              12.9009952
            ]
          ]
        ]
      },
      "id": "way/1224937858"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/1224937859",
        "amenity": "conference_centre",
        "building": "yes",
        "internet_access": "yes",
        "internet_access:fee": "no",
        "level": "0",
        "name": "RNSIT auditorium"
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              77.5179364,
              12.9003483
            ],
            [
              77.5180261,
              12.9003181
            ],
            [
              77.5181867,
              12.9003063
            ],
            [
              77.5182558,
              12.9004251
            ],
            [
              77.518268,
              12.9005282
            ],
            [
              77.5181257,
              12.9005995
            ],
            [
              77.5180301,
              12.9006287
            ],
            [
              77.5179364,
              12.9003483
            ]
          ]
        ]
      },
      "id": "way/1224937859"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/1224941276",
        "addr:city": "Bangalore",
        "building": "yes",
        "building:levels": "4",
        "layer": "1",
        "name": "RNS International School"
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              77.5168263,
              12.9010427
            ],
            [
              77.5166633,
              12.9006363
            ],
            [
              77.5165483,
              12.9003452
            ],
            [
              77.5167231,
              12.9002796
            ],
            [
              77.5168381,
              12.9005708
            ],
            [
              77.5169962,
              12.9009774
            ],
            [
              77.5168263,
              12.9010427
            ]
          ]
        ]
      },
      "id": "way/1224941276"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/1224941277",
        "access": "students",
        "hoops": "2",
        "leisure": "pitch",
        "lit": "no",
        "name": "Basketball Court",
        "name:kn": "ಬಾಸ್ಕೆಟ್ ಬಾಲ್",
        "sport": "basketball",
        "surface": "paved"
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              77.519212,
              12.9019081
            ],
            [
              77.5193492,
              12.901874
            ],
            [
              77.519412,
              12.9021139
            ],
            [
              77.5192749,
              12.9021481
            ],
            [
              77.519212,
              12.9019081
            ]
          ]
        ]
      },
      "id": "way/1224941277"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/1363986210",
        "building": "yes"
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              77.517124,
              12.9013312
            ],
            [
              77.5170508,
              12.9011508
            ],
            [
              77.5174646,
              12.9009913
            ],
            [
              77.5175378,
              12.9011718
            ],
            [
              77.517124,
              12.9013312
            ]
          ]
        ]
      },
      "id": "way/1363986210"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/1363986211",
        "building": "yes"
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              77.5172306,
              12.9016093
            ],
            [
              77.5171663,
              12.9014506
            ],
            [
              77.5175314,
              12.90131
            ],
            [
              77.5175957,
              12.9014686
            ],
            [
              77.5172306,
              12.9016093
            ]
          ]
        ]
      },
      "id": "way/1363986211"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/1486312654",
        "amenity": "motorcycle_parking",
        "capacity": "0"
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              77.5185252,
              12.9000252
            ],
            [
              77.5184624,
              12.8998361
            ],
            [
              77.518456,
              12.8998167
            ],
            [
              77.5187778,
              12.8997509
            ],
            [
              77.5188573,
              12.8999465
            ],
            [
              77.5185252,
              12.9000252
            ]
          ]
        ]
      },
      "id": "way/1486312654"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/1486312655",
        "amenity": "fast_food",
        "building": "yes",
        "cuisine": "chinese;north_indian;south_indian;snacks",
        "diet:vegetarian": "yes",
        "fast_food": "cafeteria",
        "level": "-1",
        "name": "Canteen"
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              77.5176216,
              12.9007541
            ],
            [
              77.5175201,
              12.9004882
            ],
            [
              77.5179364,
              12.9003483
            ],
            [
              77.5180301,
              12.9006287
            ],
            [
              77.5176216,
              12.9007541
            ]
          ]
        ]
      },
      "id": "way/1486312655"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/1486312656",
        "building": "yes",
        "building:levels": "4",
        "name": "RNSIT Civil and AIML Block"
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              77.51733,
              12.9019164
            ],
            [
              77.5172582,
              12.90175
            ],
            [
              77.5175888,
              12.901598
            ],
            [
              77.517681,
              12.9017777
            ],
            [
              77.51733,
              12.9019164
            ]
          ]
        ]
      },
      "id": "way/1486312656"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/204638944",
        "highway": "steps"
      },
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [
            77.5181508,
            12.9021957
          ],
          [
            77.5184636,
            12.9021299
          ]
        ]
      },
      "id": "way/204638944"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/204638945",
        "highway": "steps"
      },
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [
            77.518632,
            12.9020944
          ],
          [
            77.5187235,
            12.9020756
          ],
          [
            77.5189313,
            12.902033
          ]
        ]
      },
      "id": "way/204638945"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/204638946",
        "access": "private",
        "highway": "service"
      },
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [
            77.5171648,
            12.9020498
          ],
          [
            77.5180351,
            12.9018687
          ]
        ]
      },
      "id": "way/204638946"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/204638947",
        "access": "private",
        "foot": "yes",
        "highway": "footway"
      },
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [
            77.5180351,
            12.9018687
          ],
          [
            77.5179013,
            12.9011397
          ]
        ]
      },
      "id": "way/204638947"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/204638948",
        "access": "private",
        "highway": "service"
      },
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [
            77.518456,
            12.8998167
          ],
          [
            77.5186595,
            12.8997651
          ],
          [
            77.5187635,
            12.8997442
          ],
          [
            77.5187778,
            12.8997509
          ],
          [
            77.5187943,
            12.8997586
          ],
          [
            77.5188218,
            12.8997952
          ],
          [
            77.5188486,
            12.8999122
          ],
          [
            77.5188573,
            12.8999465
          ],
          [
            77.5188976,
            12.9001063
          ],
          [
            77.5190444,
            12.9005482
          ],
          [
            77.5192322,
            12.9010475
          ],
          [
            77.5194219,
            12.9015482
          ],
          [
            77.5195668,
            12.9020247
          ],
          [
            77.5195661,
            12.902075
          ],
          [
            77.519538,
            12.9020999
          ],
          [
            77.5194468,
            12.9021326
          ],
          [
            77.5191573,
            12.9022097
          ]
        ]
      },
      "id": "way/204638948"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/204638949",
        "access": "private",
        "highway": "service"
      },
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [
            77.5191851,
            12.9023441
          ],
          [
            77.5191573,
            12.9022097
          ],
          [
            77.5189296,
            12.901278
          ],
          [
            77.518862,
            12.9010282
          ],
          [
            77.5187383,
            12.9006673
          ],
          [
            77.5185252,
            12.9000252
          ],
          [
            77.5185138,
            12.8999908
          ],
          [
            77.5184724,
            12.8998662
          ],
          [
            77.5184624,
            12.8998361
          ],
          [
            77.518456,
            12.8998167
          ],
          [
            77.518399,
            12.8998256
          ],
          [
            77.5181311,
            12.8998789
          ],
          [
            77.5178763,
            12.8999312
          ],
          [
            77.517381,
            12.9000124
          ],
          [
            77.5173023,
            12.9000253
          ],
          [
            77.5169623,
            12.9000702
          ],
          [
            77.5168276,
            12.900088
          ],
          [
            77.5166183,
            12.90015
          ],
          [
            77.5165587,
            12.9001276
          ],
          [
            77.5164789,
            12.9000354
          ],
          [
            77.5164065,
            12.8999804
          ],
          [
            77.5163204,
            12.8999746
          ],
          [
            77.5158593,
            12.9001135
          ]
        ]
      },
      "id": "way/204638949"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/204638950",
        "access": "private",
        "highway": "service"
      },
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [
            77.5181534,
            12.9025136
          ],
          [
            77.5182603,
            12.9025087
          ],
          [
            77.5186362,
            12.9024506
          ],
          [
            77.5191851,
            12.9023441
          ]
        ]
      },
      "id": "way/204638950"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/655840340",
        "access": "private",
        "foot": "yes",
        "highway": "footway"
      },
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [
            77.5191573,
            12.9022097
          ],
          [
            77.5186182,
            12.902353
          ],
          [
            77.5186362,
            12.9024506
          ]
        ]
      },
      "id": "way/655840340"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/768598925",
        "access": "private",
        "highway": "service"
      },
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [
            77.5175131,
            12.9009114
          ],
          [
            77.5176067,
            12.9012259
          ],
          [
            77.5176969,
            12.9015287
          ],
          [
            77.5177399,
            12.9017338
          ],
          [
            77.5177675,
            12.9018022
          ],
          [
            77.5178618,
            12.9018462
          ],
          [
            77.5180351,
            12.9018687
          ]
        ]
      },
      "id": "way/768598925"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/779553100",
        "access": "private",
        "highway": "service"
      },
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [
            77.518399,
            12.8998256
          ],
          [
            77.5183491,
            12.8993788
          ],
          [
            77.5183397,
            12.8993592
          ],
          [
            77.5183269,
            12.8993448
          ],
          [
            77.5183028,
            12.8993337
          ],
          [
            77.5179595,
            12.89922
          ],
          [
            77.5179407,
            12.8992102
          ],
          [
            77.5174686,
            12.898684
          ],
          [
            77.5174566,
            12.8986651
          ],
          [
            77.5174472,
            12.8986422
          ],
          [
            77.517299,
            12.8978284
          ],
          [
            77.5172849,
            12.8977938
          ],
          [
            77.5172634,
            12.8977644
          ],
          [
            77.517128,
            12.8976774
          ]
        ]
      },
      "id": "way/779553100"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/788480057",
        "access": "private",
        "highway": "service",
        "source": "digitalglobe"
      },
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [
            77.5169819,
            12.9010986
          ],
          [
            77.5171083,
            12.901423
          ],
          [
            77.5172159,
            12.9016988
          ],
          [
            77.5172469,
            12.9017784
          ]
        ]
      },
      "id": "way/788480057"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/788480058",
        "access": "private",
        "foot": "yes",
        "highway": "footway",
        "source": "digitalglobe"
      },
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [
            77.5172159,
            12.9016988
          ],
          [
            77.517622,
            12.9015354
          ]
        ]
      },
      "id": "way/788480058"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/788480059",
        "access": "private",
        "foot": "yes",
        "highway": "footway",
        "source": "digitalglobe"
      },
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [
            77.5171083,
            12.901423
          ],
          [
            77.5175176,
            12.9012579
          ]
        ]
      },
      "id": "way/788480059"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/788480060",
        "access": "private",
        "foot": "yes",
        "highway": "footway",
        "source": "digitalglobe"
      },
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [
            77.51901,
            12.9005781
          ],
          [
            77.5187383,
            12.9006673
          ]
        ]
      },
      "id": "way/788480060"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/788480061",
        "access": "private",
        "highway": "service",
        "source": "digitalglobe"
      },
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [
            77.5192005,
            12.901177
          ],
          [
            77.5189296,
            12.901278
          ]
        ]
      },
      "id": "way/788480061"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/788480062",
        "access": "private",
        "highway": "service",
        "source": "digitalglobe"
      },
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [
            77.5166183,
            12.90015
          ],
          [
            77.51652,
            12.8992112
          ],
          [
            77.5164529,
            12.8988203
          ],
          [
            77.5163458,
            12.898197
          ],
          [
            77.5162006,
            12.8973102
          ]
        ]
      },
      "id": "way/788480062"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/1101720976",
        "highway": "residential"
      },
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [
            77.5179943,
            12.9029635
          ],
          [
            77.5179474,
            12.902561
          ]
        ]
      },
      "id": "way/1101720976"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/1112008837",
        "access": "private",
        "highway": "service",
        "incline": "down"
      },
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [
            77.517639,
            12.9008952
          ],
          [
            77.5175201,
            12.9004882
          ],
          [
            77.517381,
            12.9000124
          ]
        ]
      },
      "id": "way/1112008837"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/1183883496",
        "access": "private",
        "highway": "service"
      },
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [
            77.5171648,
            12.9020498
          ],
          [
            77.5170907,
            12.901986
          ],
          [
            77.5167981,
            12.9011495
          ]
        ]
      },
      "id": "way/1183883496"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/1510483620",
        "access": "private",
        "highway": "service"
      },
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [
            77.519229,
            12.9027233
          ],
          [
            77.5192071,
            12.9025337
          ],
          [
            77.5191851,
            12.9023441
          ]
        ]
      },
      "id": "way/1510483620"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/1510483621",
        "access": "private",
        "highway": "service"
      },
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [
            77.5181534,
            12.9025136
          ],
          [
            77.5181083,
            12.9022677
          ]
        ]
      },
      "id": "way/1510483621"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/1510483622",
        "access": "private",
        "foot": "yes",
        "highway": "footway"
      },
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [
            77.5175153,
            12.9022081
          ],
          [
            77.5175232,
            12.902489
          ],
          [
            77.5181534,
            12.9025136
          ]
        ]
      },
      "id": "way/1510483622"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/1539965404",
        "access": "private",
        "highway": "service"
      },
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [
            77.5169623,
            12.9000702
          ],
          [
            77.5168689,
            12.9001572
          ],
          [
            77.5165247,
            12.900295
          ],
          [
            77.5164941,
            12.9003525
          ],
          [
            77.5167981,
            12.9011495
          ],
          [
            77.5169819,
            12.9010986
          ],
          [
            77.5170153,
            12.9010894
          ],
          [
            77.5173184,
            12.900956
          ],
          [
            77.5175131,
            12.9009114
          ],
          [
            77.517639,
            12.9008952
          ],
          [
            77.5178996,
            12.9008615
          ],
          [
            77.5181883,
            12.9007863
          ],
          [
            77.5185601,
            12.9007077
          ],
          [
            77.5187383,
            12.9006673
          ]
        ]
      },
      "id": "way/1539965404"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "way/1539965405",
        "access": "private",
        "highway": "service"
      },
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [
            77.5181083,
            12.9022677
          ],
          [
            77.5180351,
            12.9018687
          ]
        ]
      },
      "id": "way/1539965405"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "node/1644443078",
        "addr:city": "Bangalore",
        "addr:country": "IN",
        "addr:housename": "RNSIT",
        "addr:postcode": "560098",
        "addr:street": "Uttarahalli Kengeri Main Road",
        "alt_name": "RNSIT",
        "amenity": "college",
        "contact:fax": "+918028611882",
        "contact:phone": "+918028611880",
        "contact:website": "http://rnsit.ac.in/",
        "name": "RNS Institute of Technology",
        "source": "Local knowledge",
        "wikidata": "Q7277277",
        "wikipedia": "en:RNS Institute of Technology"
      },
      "geometry": {
        "type": "Point",
        "coordinates": [
          77.5183793,
          12.9017846
        ]
      },
      "id": "node/1644443078"
    },
    {
      "type": "Feature",
      "properties": {
        "@id": "node/2146315474",
        "amenity": "bank",
        "atm": "no",
        "brand": "Canara Bank",
        "brand:pa": "ਕੇਨਰਾ ਬੈਂਕ",
        "brand:ur": "کینرا بینک",
        "brand:wikidata": "Q2003777",
        "brand:wikipedia": "en:Canara Bank",
        "brand:wikipedia:pa": "ਕੇਨਰਾ ਬੈਂਕ",
        "name": "Canara Bank",
        "name:kn": "ಕೆನರಾ ಬ್ಯಾಂಕ್",
        "name:pa": "ਕੇਨਰਾ ਬੈਂਕ",
        "name:ur": "کینرا بینک",
        "website": "https://www.canarabank.com/"
      },
      "geometry": {
        "type": "Point",
        "coordinates": [
          77.5185188,
          12.9022871
        ]
      },
      "id": "node/2146315474"
    }
  ]
};
