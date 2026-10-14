Faculty & staff photographs
===========================

Drop the portrait photos into this folder and they appear automatically in the
"Faculty & staff" section of faculty.html. Until a file exists, the card shows
the school logo as a placeholder.

Expected file names (the section already points at these):

    bishop.png       -> the Bishop (School Bishop / Spiritual Director)
    teacher-1.png    -> teaching faculty card 1
    teacher-2.png    -> teaching faculty card 2
    teacher-3.png    -> teaching faculty card 3
    staff-1.png      -> non-teaching staff card 1
    staff-2.png      -> non-teaching staff card 2

Adding a real member
--------------------

1. Save the photo here, e.g. faculty/ms-cruz.png (portrait, roughly 4:5).
2. In faculty.html find the matching <figure class="faculty-card"> block and
   update three things:
     - src="faculty/ms-cruz.png"
     - alt="Photograph of Ms. Cruz"
     - the <h4> name, the .role line, and the .dept line.
3. To add another card, copy a whole <figure class="faculty-card"> ... </figure>
   block and paste it inside the matching .faculty-grid.

Any image type works (png, jpg, webp) — just match the extension in src.
