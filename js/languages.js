// Registre des langages : ajouter un langage = ajouter une entrée ici + un worker dans js/workers/.

export const LANGUAGES = [
  {
    id: 'javascript',
    name: 'JavaScript',
    short: 'JS',
    file: 'main.js',
    monaco: 'javascript',
    worker: 'js/workers/javascript.js',
    sample: `// Calcule une moyenne et affiche le résultat.
// prompt() pose une question : répondez dans la console.

function moyenne(notes) {
  let somme = 0;
  for (const note of notes) {
    somme += note;
  }
  return somme / notes.length;
}

const nom = prompt("Votre nom ?");
const notes = [12, 15, 9];
const m = moyenne(notes);

console.log(\`Bonjour \${nom}, votre moyenne est \${m.toFixed(2)}\`);
if (m >= 10) {
  console.log("Admis");
} else {
  console.log("Recalé");
}
`,
  },
  {
    id: 'python',
    name: 'Python',
    short: 'PY',
    file: 'main.py',
    monaco: 'python',
    worker: 'js/workers/python.js',
    sample: `# Calcule une moyenne et affiche le résultat.
# input() pose une question : répondez dans la console.

def moyenne(notes):
    somme = 0
    for note in notes:
        somme += note
    return somme / len(notes)

nom = input("Votre nom ? ")
notes = [12, 15, 9]
m = moyenne(notes)

print(f"Bonjour {nom}, votre moyenne est {m:.2f}")
if m >= 10:
    print("Admis")
else:
    print("Recalé")
`,
  },
  {
    id: 'php',
    name: 'PHP',
    short: 'PHP',
    file: 'main.php',
    monaco: 'php',
    worker: 'js/workers/php.js',
    module: true,
    sample: `<?php
// Calcule une moyenne et affiche le résultat.
// fgets(STDIN) attend une réponse tapée dans la console.

function moyenne($notes) {
    $somme = 0;
    foreach ($notes as $note) {
        $somme += $note;
    }
    return $somme / count($notes);
}

echo "Votre nom ? ";
$nom = trim(fgets(STDIN));
$notes = [12, 15, 9];
$m = moyenne($notes);

echo "Bonjour $nom, votre moyenne est " . number_format($m, 2) . "\\n";
if ($m >= 10) {
    echo "Admis\\n";
} else {
    echo "Recalé\\n";
}
`,
  },
  {
    id: 'c',
    name: 'C',
    short: 'C',
    file: 'main.c',
    monaco: 'c',
    worker: 'js/workers/cpp.js',
    sample: `// Calcule une moyenne et affiche le résultat.
// scanf() attend les valeurs tapées dans la console.
#include <stdio.h>

double moyenne(int notes[], int n) {
    int somme = 0;
    for (int i = 0; i < n; i++) {
        somme += notes[i];
    }
    return (double) somme / n;
}

int main() {
    int notes[3];
    int note;
    for (int i = 0; i < 3; i++) {
        printf("Note %d : ", i + 1);
        scanf("%d", &note);
        notes[i] = note;
    }
    double m = moyenne(notes, 3);
    printf("Moyenne : %.2f\\n", m);
    if (m >= 10) {
        printf("Admis\\n");
    } else {
        printf("Recale\\n");
    }
    return 0;
}
`,
  },
  {
    id: 'cpp',
    name: 'C++',
    short: 'C++',
    file: 'main.cpp',
    monaco: 'cpp',
    worker: 'js/workers/cpp.js',
    sample: `// Calcule une moyenne et affiche le résultat.
// cin attend les valeurs tapées dans la console.
#include <iostream>
using namespace std;

double moyenne(int notes[], int n) {
    int somme = 0;
    for (int i = 0; i < n; i++) {
        somme += notes[i];
    }
    return (double) somme / n;
}

int main() {
    int notes[3];
    for (int i = 0; i < 3; i++) {
        cout << "Note " << i + 1 << " : ";
        cin >> notes[i];
    }
    double m = moyenne(notes, 3);
    cout << "Moyenne : " << m << endl;
    if (m >= 10) {
        cout << "Admis" << endl;
    } else {
        cout << "Recale" << endl;
    }
    return 0;
}
`,
  },
  {
    id: 'pseudocode',
    name: 'Algorithme',
    short: 'ALGO',
    file: 'main.algo',
    monaco: 'pseudocode3s',
    worker: 'js/workers/pseudocode.js',
    sample: `ALGORITHME Moyenne
// LIRE attend une valeur tapée dans la console.

VARIABLES
    nom : CHAINE
    n, i : ENTIER
    note, somme, moy : REEL
DEBUT
    ECRIRE("Votre nom ?")
    LIRE(nom)
    ECRIRE("Combien de notes ?")
    LIRE(n)
    somme <- 0
    POUR i DE 1 A n FAIRE
        LIRE(note)
        somme <- somme + note
    FINPOUR
    moy <- somme / n
    ECRIRE("Bonjour ", nom, ", votre moyenne est ", moy)
    SI moy >= 10 ALORS
        ECRIRE("Admis")
    SINON
        ECRIRE("Recalé")
    FINSI
FIN
`,
  },
];

export const byId = Object.fromEntries(LANGUAGES.map((l) => [l.id, l]));
